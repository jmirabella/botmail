import { randomToken, sha256Hex } from "./crypto";
import { getBot, nowIso, setBotWebhook } from "./db";
import { HttpError } from "./errors";
import { logError } from "./log";
import { UNROUTED_BOT_ID } from "./seed-bots";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const WINDOW_MS = 60_000;
export const WEBHOOK_SETUP_LIMIT = 20;

export async function issueWebhookSetupCode(env: Env, botId: string): Promise<{ code: string; expires_at: string }> {
  const bot = await getBot(env, botId);
  if (!bot || bot.id === UNROUTED_BOT_ID) throw new Error("Bot not found");
  if (bot.deleted_at) throw new Error("Bot is archived. Restore it first.");
  const code = randomToken(32);
  const expiresAt = new Date(Date.now() + TEN_MINUTES_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM webhook_setup_codes WHERE bot_id = ?`).bind(bot.id),
    env.DB.prepare(`INSERT INTO webhook_setup_codes (code_hash, bot_id, expires_at, used_at) VALUES (?, ?, ?, NULL)`).bind(
      await sha256Hex(code),
      bot.id,
      expiresAt,
    ),
  ]);
  return { code, expires_at: expiresAt };
}

/** Claim the code, save the webhook, and release the claim if the save fails. */
export async function redeemWebhookSetupCode(env: Env, code: string, url: string, key: string): Promise<string> {
  const hash = await sha256Hex(code.trim());
  const now = nowIso();
  const claim = await env.DB.prepare(
    `UPDATE webhook_setup_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(now, hash, now)
    .run();
  if (!claim.meta.changes) throw new HttpError("Setup code is invalid or expired", 400, "setup_code");
  const row = await env.DB.prepare(`SELECT bot_id FROM webhook_setup_codes WHERE code_hash = ?`)
    .bind(hash)
    .first<{ bot_id: string }>();
  if (!row) throw new HttpError("Setup code is invalid or expired", 400, "setup_code");
  try {
    await setBotWebhook(env, row.bot_id, url, key);
  } catch (error) {
    await env.DB.prepare(`UPDATE webhook_setup_codes SET used_at = NULL WHERE code_hash = ? AND used_at = ?`).bind(hash, now).run();
    throw error;
  }
  return row.bot_id;
}

export async function allowWebhookSetup(env: Env, ip: string): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / WINDOW_MS);
  await env.DB.prepare(`DELETE FROM webhook_setup_hits WHERE window_start < ?`).bind(windowStart).run();
  const row = await env.DB.prepare(
    `INSERT INTO webhook_setup_hits (ip, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT(ip, window_start) DO UPDATE SET hits = hits + 1
     RETURNING hits`,
  )
    .bind(ip.slice(0, 200) || "unknown", windowStart)
    .first<{ hits: number }>();
  return (row?.hits ?? WEBHOOK_SETUP_LIMIT + 1) <= WEBHOOK_SETUP_LIMIT;
}

export async function handleWebhookSetup(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  if (!(await allowWebhookSetup(env, ip))) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : "";
  const url = typeof record.url === "string" ? record.url : "";
  const key = typeof record.key === "string" ? record.key : "";
  if (!code.trim() || !url.trim() || !key.trim()) {
    return Response.json({ error: "code, url, and key are required" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  try {
    const bot = await redeemWebhookSetupCode(env, code, url, key);
    return Response.json({ ok: true, bot }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    const message = error instanceof Error ? error.message : "Could not save the webhook";
    const known = /https|required|redacted|archived|not found/i.test(message);
    if (!known) logError("webhook_setup_failed", { error: message });
    return Response.json(
      { error: known ? message : "Could not save the webhook" },
      { status: known ? 400 : 500, headers: { "cache-control": "no-store" } },
    );
  }
}
