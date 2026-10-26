import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { getBot, webhookKey } from "../src/db";
import worker from "../src/index";
import { WEBHOOK_SETUP_LIMIT } from "../src/webhook-setup";
import { adminRequest, mcpCall } from "./helpers";

async function createHookCode(): Promise<string> {
  const created = await worker.fetch(
    await adminRequest("/admin/api/bots", {
      method: "POST",
      headers: { "content-type": "application/json", "x-bot-mail-action": "1" },
      body: JSON.stringify({ local_part: "hookcode", display_name: "Hook code", notes: "webhook setup test" }),
    }),
    env,
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { api_key: string }).api_key;
}

async function setupPost(body: unknown, connectingIp = "203.0.113.50"): Promise<Response> {
  return worker.fetch(
    new Request(`https://${env.PUBLIC_HOST}/webhook-setup`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": connectingIp },
      body: JSON.stringify(body),
    }),
    env,
  );
}

afterEach(async () => {
  await env.DB.prepare(`DELETE FROM webhook_setup_codes WHERE bot_id = 'hookcode'`).run();
  // Fixture reset only. The Worker never deletes address_registry rows.
  await env.DB.prepare(`DELETE FROM address_registry WHERE owner_id = 'hookcode'`).run();
  await env.DB.prepare(`DELETE FROM bots WHERE id = 'hookcode'`).run();
  await env.DB.prepare(`DELETE FROM webhook_setup_hits`).run();
});

describe("webhook setup code", () => {
  it("issues a one-time code for the authenticated mailbox", async () => {
    const key = await createHookCode();
    const denied = await worker.fetch(
      new Request(`https://${env.PUBLIC_HOST}/mcp`, {
        method: "POST",
        headers: { host: env.PUBLIC_HOST, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "webhook_setup_code", arguments: {} } }),
      }),
      env,
    );
    expect(denied.status).toBe(401);
    await expect(mcpCall("test-admin-key", "webhook_setup_code", {})).rejects.toThrow();

    const issued = (await mcpCall(key, "webhook_setup_code", {})) as { code: string; bot: string; expires_at: string };
    expect(issued.bot).toBe("hookcode");
    expect(issued.code.length).toBeGreaterThan(20);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeLessThan(11 * 60 * 1000);
    const stored = await env.DB.prepare(`SELECT code_hash FROM webhook_setup_codes WHERE bot_id = 'hookcode'`).first<{ code_hash: string }>();
    expect(stored?.code_hash).not.toBe(issued.code);
  });

  it("saves the webhook once and strips a leading Bearer", async () => {
    const key = await createHookCode();
    const issued = (await mcpCall(key, "webhook_setup_code", {})) as { code: string };
    const saved = await setupPost({
      code: issued.code,
      url: "https://hooks.example.test/hookcode",
      key: "  Bearer   routine-secret  ",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, bot: "hookcode" });
    const row = await getBot(env, "hookcode");
    expect(row?.webhook_url).toBe("https://hooks.example.test/hookcode");
    expect(await webhookKey(env, row!)).toBe("routine-secret");

    const replay = await setupPost({ code: issued.code, url: "https://hooks.example.test/other", key: "second-secret" });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("Setup code is invalid or expired");
    expect((await getBot(env, "hookcode"))?.webhook_url).toBe("https://hooks.example.test/hookcode");
    expect(await webhookKey(env, (await getBot(env, "hookcode"))!)).toBe("routine-secret");

    const again = (await mcpCall(key, "webhook_setup_code", {})) as { code: string };
    await env.DB.prepare(`UPDATE webhook_setup_codes SET expires_at = ? WHERE bot_id = 'hookcode'`).bind("2000-01-01T00:00:00.000Z").run();
    const expired = await setupPost({ code: again.code, url: "https://hooks.example.test/late", key: "late-secret" });
    expect(expired.status).toBe(400);
    expect((await getBot(env, "hookcode"))?.webhook_url).toBe("https://hooks.example.test/hookcode");
  });

  it("rate-limits the public endpoint", async () => {
    const limitedIp = "203.0.113.77";
    for (let i = 0; i < WEBHOOK_SETUP_LIMIT; i++) {
      const response = await setupPost({ code: "nope", url: "https://hooks.example.test/nope", key: "nope" }, limitedIp);
      expect(response.status, String(i)).toBe(400);
    }
    const blocked = await setupPost({ code: "nope", url: "https://hooks.example.test/nope", key: "nope" }, limitedIp);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });
});
