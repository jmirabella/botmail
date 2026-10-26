import { claimsOwnerDomain } from "./address";
import { getBot, webhookKey, type BotRow, type MessageRow } from "./db";
import { logError, logInfo } from "./log";
import { UNROUTED_BOT_ID } from "./seed-bots";

export const WEBHOOK_TIMEOUT_MS = 8000;
export const WEBHOOK_MAX_ATTEMPTS = 8;

export type EmailReceivedEvent = {
  event: "email_received" | "wake_test";
  bot: string;
  address: string;
  message_id: string;
  from: string;
  subject: string;
  snippet: string;
  thread_id: string;
  received_at: string;
  auth_result: string;
  claims_owner_domain: boolean;
  via_alias?: string;
};

export function emailReceivedEvent(env: Env, bot: BotRow, message: MessageRow): EmailReceivedEvent {
  return {
    event: "email_received",
    bot: bot.id,
    address: `${bot.address_local}@${bot.domain}`,
    message_id: message.id,
    from: message.from_addr,
    subject: message.subject ?? "",
    snippet: message.snippet ?? "",
    thread_id: message.thread_id ?? message.id,
    received_at: message.message_date ?? message.created_at,
    auth_result: message.auth_result ?? "",
    claims_owner_domain: claimsOwnerDomain(message.from_addr, ownerDomains(env)),
    ...(message.via_alias ? { via_alias: message.via_alias } : {}),
  };
}

function ownerDomains(env: Env): string[] {
  return String(env.ACCESS_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export async function notifyBot(
  env: Env,
  bot: BotRow,
  message: MessageRow,
  fetcher?: typeof fetch,
): Promise<void> {
  if (message.direction !== "in" || message.folder === "_unrouted" || !bot.webhook_url) return;
  if (bot.enabled !== 1 || bot.deleted_at || bot.id === UNROUTED_BOT_ID) return;
  const payload = emailReceivedEvent(env, bot, message);
  const key = await webhookKey(env, bot);
  const deliveryId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
      (id, bot_id, message_id, url, status, attempts, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  )
    .bind(deliveryId, bot.id, message.id, bot.webhook_url, JSON.stringify(payload), stamp, stamp)
    .run();
  await attemptDelivery(env, deliveryId, bot.webhook_url, key, payload, activeFetch(fetcher));
}

/** The bot to post to, or null when the queued row must be cancelled instead of sent. Disabled and archived bots are not woken. */
async function currentWebhookBot(env: Env, deliveryId: string, url: string): Promise<BotRow | null> {
  const row = await env.DB.prepare(`SELECT bot_id, url, status FROM webhook_deliveries WHERE id = ?`)
    .bind(deliveryId)
    .first<{ bot_id: string; url: string; status: string }>();
  if (!row || row.status === "cancelled") return null;
  const bot = await getBot(env, row.bot_id);
  const current = Boolean(
    bot && bot.enabled === 1 && bot.id !== UNROUTED_BOT_ID && !bot.deleted_at && bot.webhook_url === row.url && row.url === url,
  );
  if (current && bot) return bot;
  if (row.status === "pending" || row.status === "failed") {
    const reason =
      !bot || bot.deleted_at || bot.id === UNROUTED_BOT_ID ? "bot archived" : bot.enabled !== 1 ? "bot disabled" : "webhook target changed";
    await env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'cancelled', last_error = ?, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'failed')`,
    )
      .bind(reason, new Date().toISOString(), deliveryId)
      .run();
  }
  return null;
}

async function attemptDelivery(
  env: Env,
  deliveryId: string,
  url: string,
  key: string | null,
  payload: EmailReceivedEvent,
  fetcher: typeof fetch,
): Promise<void> {
  const stamp = new Date().toISOString();
  if (!(await currentWebhookBot(env, deliveryId, url))) return;
  if (!key) {
    await markDelivery(env, deliveryId, {
      status: "failed",
      error: "webhook key missing",
      code: null,
      stamp,
    });
    logError("webhook_failed", { delivery_id: deliveryId, bot: payload.bot, error: "webhook key missing" });
    return;
  }
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "x-automation-key": key,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      await markDelivery(env, deliveryId, {
        status: "failed",
        error: `HTTP ${response.status}`,
        code: response.status,
        stamp,
      });
      logError("webhook_failed", { delivery_id: deliveryId, bot: payload.bot, status: response.status });
      return;
    }
    await markDelivery(env, deliveryId, { status: "success", error: null, code: response.status, stamp });
    logInfo("webhook_delivered", { delivery_id: deliveryId, bot: payload.bot, message_id: payload.message_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "webhook request failed";
    await markDelivery(env, deliveryId, { status: "failed", error: message, code: null, stamp });
    logError("webhook_failed", { delivery_id: deliveryId, bot: payload.bot, error: message });
  }
}

async function markDelivery(
  env: Env,
  id: string,
  result: { status: "success" | "failed"; error: string | null; code: number | null; stamp: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries
     SET status = ?, attempts = attempts + 1, last_status_code = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status != 'cancelled'`,
  )
    .bind(result.status, result.code, result.error, result.stamp, id)
    .run();
}

let deliveryFetch: typeof fetch | null = null;

export function setDeliveryFetch(next: typeof fetch | null): void {
  deliveryFetch = next;
}

function activeFetch(explicit?: typeof fetch): typeof fetch {
  return explicit ?? deliveryFetch ?? fetch;
}

export async function sendTestWake(env: Env, botId: string, fetcher?: typeof fetch): Promise<{ id: string; status: string; attempts: number; last_error: string | null }> {
  const bot = await getBot(env, botId);
  if (!bot || bot.id === "_unrouted") throw new Error("Bot not found");
  if (bot.deleted_at) throw new Error("Bot is archived. Restore it first.");
  if (bot.enabled !== 1) throw new Error("Bot is disabled");
  if (!bot.webhook_url) throw new Error("Webhook URL is not set");
  const stamp = new Date().toISOString();
  const payload: EmailReceivedEvent = {
    event: "wake_test",
    bot: bot.id,
    address: `${bot.address_local}@${bot.domain}`,
    message_id: "",
    from: "botmail@localhost",
    subject: "BotMail wake test",
    snippet: "Manual wake test from the Connect panel",
    thread_id: "",
    received_at: stamp,
    auth_result: "",
    claims_owner_domain: false,
  };
  const deliveryId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
      (id, bot_id, message_id, url, status, attempts, payload, created_at, updated_at)
     VALUES (?, ?, '', ?, 'pending', 0, ?, ?, ?)`,
  )
    .bind(deliveryId, bot.id, bot.webhook_url, JSON.stringify(payload), stamp, stamp)
    .run();
  const key = await webhookKey(env, bot);
  await attemptDelivery(env, deliveryId, bot.webhook_url, key, payload, activeFetch(fetcher));
  return deliveryStatus(env, deliveryId);
}

export async function retryDelivery(env: Env, id: string, fetcher?: typeof fetch): Promise<{ id: string; status: string; attempts: number; last_error: string | null }> {
  const row = await env.DB.prepare(`SELECT id, bot_id, url, payload FROM webhook_deliveries WHERE id = ?`)
    .bind(id)
    .first<{ id: string; bot_id: string; url: string; payload: string }>();
  if (!row) throw new Error("Delivery not found");
  let payload: EmailReceivedEvent;
  try {
    payload = JSON.parse(row.payload) as EmailReceivedEvent;
  } catch {
    throw new Error("Delivery payload is unreadable");
  }
  const bot = await currentWebhookBot(env, row.id, row.url);
  if (!bot) return deliveryStatus(env, row.id);
  const key = await webhookKey(env, bot);
  await attemptDelivery(env, row.id, row.url, key, payload, activeFetch(fetcher));
  return deliveryStatus(env, row.id);
}

async function deliveryStatus(env: Env, id: string): Promise<{ id: string; status: string; attempts: number; last_error: string | null }> {
  const row = await env.DB.prepare(`SELECT id, status, attempts, last_error FROM webhook_deliveries WHERE id = ?`)
    .bind(id)
    .first<{ id: string; status: string; attempts: number; last_error: string | null }>();
  if (!row) throw new Error("Delivery not found");
  return row;
}

export async function drainWebhooks(env: Env, limit = 20, fetcher: typeof fetch = fetch): Promise<{ retried: number; succeeded: number }> {
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, bot_id, url, payload, attempts FROM webhook_deliveries
     WHERE attempts < ?
       AND (
         status = 'failed'
         OR (status = 'pending' AND updated_at < ?)
       )
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(WEBHOOK_MAX_ATTEMPTS, cutoff, limit)
    .all<{ id: string; bot_id: string; url: string; payload: string; attempts: number }>();

  let succeeded = 0;
  for (const row of rows.results) {
    let payload: EmailReceivedEvent;
    try {
      payload = JSON.parse(row.payload) as EmailReceivedEvent;
    } catch {
      continue;
    }
    const before = row.attempts;
    const bot = await currentWebhookBot(env, row.id, row.url);
    if (!bot) continue;
    const key = await webhookKey(env, bot);
    await attemptDelivery(env, row.id, row.url, key, payload, fetcher);
    const after = await env.DB.prepare(`SELECT status, attempts FROM webhook_deliveries WHERE id = ?`)
      .bind(row.id)
      .first<{ status: string; attempts: number }>();
    if (after?.status === "success" && after.attempts > before) succeeded += 1;
  }
  return { retried: rows.results.length, succeeded };
}
