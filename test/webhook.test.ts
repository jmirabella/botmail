import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createBot, deleteBot, getBot, setBotWebhook, updateBot } from "../src/db";
import { processInboundEmail } from "../src/inbound";
import worker from "../src/index";
import { drainWebhooks, retryDelivery, sendTestWake } from "../src/webhook";
import { inboundMessage, rawMime } from "./helpers";

describe("webhook ping", () => {
  it("posts the email_received event without the body", async () => {
    await setBotWebhook(env, "athena", "https://hooks.example.test/athena", "athena-sender-key");
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const raw = rawMime({
      from: "Ada <ada@example.com>",
      to: "athena@bots.example.test",
      subject: "Watch this",
      text: `${"visible snippet ".repeat(5)}${"x".repeat(400)}END_MARKER_SHOULD_NOT_PING`,
      messageId: "<hook-athena@bots.example.test>",
    });
    const incoming = inboundMessage(raw, "ada@example.com", "athena@bots.example.test");
    await processInboundEmail(incoming.message, env, {
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ""),
        });
        return new Response(null, { status: 204 });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://hooks.example.test/athena");
    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer athena-sender-key");
    expect(seen[0]?.headers.get("x-automation-key")).toBe("athena-sender-key");
    const payload = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "address",
      "auth_result",
      "bot",
      "claims_owner_domain",
      "event",
      "from",
      "message_id",
      "received_at",
      "snippet",
      "subject",
      "thread_id",
    ]);
    expect(payload.auth_result).toBe("unverified");
    expect(payload.claims_owner_domain).toBe(true);
    expect(payload.event).toBe("email_received");
    expect(payload.bot).toBe("athena");
    expect(payload.address).toBe("athena@bots.example.test");
    expect(payload.from).toBe("ada@example.com");
    expect(payload.subject).toBe("Watch this");
    expect(payload.snippet).toContain("visible snippet");
    expect(JSON.stringify(payload)).not.toContain("END_MARKER_SHOULD_NOT_PING");
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("html");
    expect(payload).not.toHaveProperty("attachments");

    const delivery = await env.DB.prepare(`SELECT status, attempts FROM webhook_deliveries WHERE bot_id = ?`)
      .bind("athena")
      .first<{ status: string; attempts: number }>();
    expect(delivery).toEqual({ status: "success", attempts: 1 });
  });

  it("records a failed delivery and drains it later", async () => {
    await setBotWebhook(env, "argus", "https://hooks.example.test/argus", "argus-sender-key");
    let calls = 0;
    const raw = rawMime({
      from: "ada@example.com",
      to: "argus@bots.example.test",
      subject: "Retry me",
      text: "body stays in the mailbox",
      messageId: "<hook-argus@bots.example.test>",
    });
    const incoming = inboundMessage(raw, "ada@example.com", "argus@bots.example.test");
    await processInboundEmail(incoming.message, env, {
      fetch: async () => {
        calls += 1;
        return new Response("nope", { status: 503 });
      },
    });
    const failed = await env.DB.prepare(`SELECT id, status, last_error FROM webhook_deliveries WHERE bot_id = ?`)
      .bind("argus")
      .first<{ id: string; status: string; last_error: string }>();
    expect(failed?.status).toBe("failed");
    expect(failed?.last_error).toBe("HTTP 503");

    await env.DB.prepare(`DELETE FROM webhook_deliveries WHERE bot_id != ? AND status = 'failed'`)
      .bind("argus")
      .run();
    await env.DB.prepare(`UPDATE webhook_deliveries SET updated_at = ? WHERE id = ?`)
      .bind("2020-01-01T00:00:00.000Z", failed?.id)
      .run();
    const drained = await drainWebhooks(env, 10, async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    });
    expect(drained.retried).toBe(1);
    expect(drained.succeeded).toBe(1);
    expect(calls).toBe(2);
    const after = await env.DB.prepare(`SELECT status FROM webhook_deliveries WHERE id = ?`)
      .bind(failed?.id)
      .first<{ status: string }>();
    expect(after?.status).toBe("success");
  });

  it("wires the email handler to a webhook attempt", async () => {
    await setBotWebhook(env, "vista", "https://hooks.example.test/vista", "vista-sender-key");
    const raw = rawMime({
      from: "ada@example.com",
      to: "vista@bots.example.test",
      subject: "From the handler",
      text: "stored even if the hook fails",
      messageId: "<hook-vista@bots.example.test>",
    });
    const incoming = inboundMessage(raw, "ada@example.com", "vista@bots.example.test");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("down", { status: 500 });
    try {
      await worker.email(incoming.message, env);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const row = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`)
      .bind("<hook-vista@bots.example.test>")
      .first<{ id: string }>();
    expect(row?.id).toBeTruthy();
    const delivery = await env.DB.prepare(`SELECT status FROM webhook_deliveries WHERE message_id = ?`)
      .bind(row?.id)
      .first<{ status: string }>();
    expect(delivery?.status).toBe("failed");
  });

  it("does not retry a queued delivery after the webhook url changes", async () => {
    const oldUrl = "https://hooks.example.test/hookold-old";
    const { bot } = await createBot(env, { id: "hookold", local: "hookold", displayName: "Hook Old" });
    await setBotWebhook(env, bot.id, oldUrl, "hookold-sender-key");
    const messageId = `<hook-old-${crypto.randomUUID()}@example.com>`;
    const raw = rawMime({
      from: "ada@example.com",
      to: "hookold@bots.example.test",
      subject: "Stale hook",
      text: "queue this",
      messageId,
    });
    const incoming = inboundMessage(raw, "ada@example.com", "hookold@bots.example.test");
    await processInboundEmail(incoming.message, env, {
      fetch: async () => new Response("nope", { status: 503 }),
    });
    const queued = await env.DB.prepare(`SELECT id, url, status FROM webhook_deliveries WHERE bot_id = ?`)
      .bind(bot.id)
      .first<{ id: string; url: string; status: string }>();
    expect(queued).toMatchObject({ url: oldUrl, status: "failed" });

    await setBotWebhook(env, bot.id, "https://hooks.example.test/hookold-new", "hookold-sender-key");
    const cancelled = await env.DB.prepare(`SELECT id, status FROM webhook_deliveries WHERE id = ?`)
      .bind(queued?.id)
      .first<{ id: string; status: string }>();
    expect(cancelled).toEqual({ id: queued?.id, status: "cancelled" });

    // A row drain already loaded can still carry the old URL. It must not be posted.
    await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE id = ?`)
      .bind("2000-01-01T00:00:00.000Z", queued?.id)
      .run();
    const seen: string[] = [];
    await drainWebhooks(env, 50, async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 204 });
    });
    expect(seen).not.toContain(oldUrl);
    const after = await env.DB.prepare(`SELECT id, status, url FROM webhook_deliveries WHERE id = ?`)
      .bind(queued?.id)
      .first<{ id: string; status: string; url: string }>();
    expect(after).toEqual({ id: queued?.id, status: "cancelled", url: oldUrl });
  });

  it("does not retry a queued delivery after the bot is archived", async () => {
    const url = "https://hooks.example.test/hookgone";
    const { bot } = await createBot(env, { id: "hookgone", local: "hookgone", displayName: "Hook Gone" });
    await setBotWebhook(env, bot.id, url, "hookgone-sender-key");
    const messageId = `<hook-gone-${crypto.randomUUID()}@example.com>`;
    const raw = rawMime({
      from: "ada@example.com",
      to: "hookgone@bots.example.test",
      subject: "Archived hook",
      text: "queue this",
      messageId,
    });
    const incoming = inboundMessage(raw, "ada@example.com", "hookgone@bots.example.test");
    await processInboundEmail(incoming.message, env, {
      fetch: async () => new Response("nope", { status: 503 }),
    });
    const queued = await env.DB.prepare(`SELECT id, status FROM webhook_deliveries WHERE bot_id = ?`)
      .bind(bot.id)
      .first<{ id: string; status: string }>();
    expect(queued?.status).toBe("failed");

    await deleteBot(env, bot.id);
    const stored = await getBot(env, bot.id);
    expect(stored?.deleted_at).toBeTruthy();
    expect(stored?.webhook_key_ct).toBeNull();
    expect(stored?.webhook_key_iv).toBeNull();
    const cancelled = await env.DB.prepare(`SELECT id, status FROM webhook_deliveries WHERE id = ?`)
      .bind(queued?.id)
      .first<{ id: string; status: string }>();
    expect(cancelled).toEqual({ id: queued?.id, status: "cancelled" });

    await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE id = ?`)
      .bind("2000-01-01T00:00:00.000Z", queued?.id)
      .run();
    const seen: string[] = [];
    await drainWebhooks(env, 50, async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 204 });
    });
    expect(seen).not.toContain(url);
    const after = await env.DB.prepare(`SELECT id, status FROM webhook_deliveries WHERE id = ?`)
      .bind(queued?.id)
      .first<{ id: string; status: string }>();
    expect(after).toEqual({ id: queued?.id, status: "cancelled" });
    expect((await getBot(env, bot.id))?.webhook_key_ct).toBeNull();
  });

  it("skips retries for a disabled bot, an archived bot, and a stale url", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response(null, { status: 204 });
    };

    const staleUrl = "https://hooks.example.test/hookstale";
    await createBot(env, { id: "hookstale", local: "hookstale", displayName: "Hook Stale" });
    await setBotWebhook(env, "hookstale", staleUrl, "hookstale-key");
    const staleId = await failDelivery("hookstale", "Stale hook");
    await setBotWebhook(env, "hookstale", "https://hooks.example.test/hookstale-new", "hookstale-key");
    await reopen(staleId);
    await drainWebhooks(env, 50, fetcher);
    await retryDelivery(env, staleId, fetcher);
    expect(seen).not.toContain(staleUrl);
    expect(await deliveryStatus(staleId)).toBe("cancelled");

    const offUrl = "https://hooks.example.test/hookoff";
    await createBot(env, { id: "hookoff", local: "hookoff", displayName: "Hook Off" });
    await setBotWebhook(env, "hookoff", offUrl, "hookoff-key");
    await env.DB.prepare(`INSERT INTO oauth_connection (bot_id, grant_id, created_at) VALUES ('hookoff', 'grant-hookoff', ?)`)
      .bind(new Date().toISOString())
      .run();
    const offId = await failDelivery("hookoff", "Disabled hook");
    await updateBot(env, "hookoff", { enabled: false });
    const disabled = await getBot(env, "hookoff");
    expect(disabled?.enabled).toBe(0);
    expect(disabled?.api_key_hash).toBeNull();
    expect(disabled?.webhook_key_ct).toBeNull();
    expect(disabled?.webhook_key_iv).toBeNull();
    const connection = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = 'hookoff'`).first<{
      grant_id: string;
      revoked_at: string | null;
    }>();
    expect(connection?.grant_id).toBe("grant-hookoff");
    expect(connection?.revoked_at).toBeTruthy();
    expect(await deliveryStatus(offId)).toBe("cancelled");
    await expect(sendTestWake(env, "hookoff", fetcher)).rejects.toThrow(/disabled/);
    await reopen(offId);
    await drainWebhooks(env, 50, fetcher);
    await retryDelivery(env, offId, fetcher);
    expect(seen).not.toContain(offUrl);

    await updateBot(env, "hookoff", { enabled: true });
    const enabled = await getBot(env, "hookoff");
    expect(enabled?.enabled).toBe(1);
    expect(enabled?.api_key_hash).toBeNull();
    expect(enabled?.webhook_key_ct).toBeNull();
    const still = await env.DB.prepare(`SELECT revoked_at FROM oauth_connection WHERE bot_id = 'hookoff'`).first<{ revoked_at: string | null }>();
    expect(still?.revoked_at).toBe(connection?.revoked_at);
    await drainWebhooks(env, 50, fetcher);
    await retryDelivery(env, offId, fetcher);
    expect(seen).not.toContain(offUrl);

    const goneUrl = "https://hooks.example.test/hookarch";
    await createBot(env, { id: "hookarch", local: "hookarch", displayName: "Hook Arch" });
    await setBotWebhook(env, "hookarch", goneUrl, "hookarch-key");
    const goneId = await failDelivery("hookarch", "Archived hook");
    await deleteBot(env, "hookarch");
    expect((await getBot(env, "hookarch"))?.webhook_key_ct).toBeNull();
    await reopen(goneId);
    await drainWebhooks(env, 50, fetcher);
    await retryDelivery(env, goneId, fetcher);
    expect(seen).not.toContain(goneUrl);
    expect(await deliveryStatus(goneId)).toBe("cancelled");
  });

  it("does not overwrite a delivery cancelled while the request is in flight", async () => {
    const url = "https://hooks.example.test/hookrace";
    await createBot(env, { id: "hookrace", local: "hookrace", displayName: "Hook Race" });
    await setBotWebhook(env, "hookrace", url, "hookrace-key");
    const messageId = `<hook-race-${crypto.randomUUID()}@example.com>`;
    const raw = rawMime({
      from: "ada@example.com",
      to: "hookrace@bots.example.test",
      subject: "In flight",
      text: "cancel during fetch",
      messageId,
    });
    const incoming = inboundMessage(raw, "ada@example.com", "hookrace@bots.example.test");
    await processInboundEmail(incoming.message, env, {
      fetch: async () => {
        await env.DB.prepare(
          `UPDATE webhook_deliveries SET status = 'cancelled', last_error = 'bot disabled' WHERE bot_id = 'hookrace' AND status = 'pending'`,
        ).run();
        return new Response("nope", { status: 500 });
      },
    });
    const after = await env.DB.prepare(`SELECT status, attempts, last_error FROM webhook_deliveries WHERE bot_id = 'hookrace'`).first<{
      status: string;
      attempts: number;
      last_error: string | null;
    }>();
    expect(after).toEqual({ status: "cancelled", attempts: 0, last_error: "bot disabled" });
  });
});

async function failDelivery(botId: string, subject: string): Promise<string> {
  const messageId = `<${botId}-${crypto.randomUUID()}@example.com>`;
  const raw = rawMime({
    from: "ada@example.com",
    to: `${botId}@bots.example.test`,
    subject,
    text: "queue this",
    messageId,
  });
  const incoming = inboundMessage(raw, "ada@example.com", `${botId}@bots.example.test`);
  await processInboundEmail(incoming.message, env, {
    fetch: async () => new Response("nope", { status: 503 }),
  });
  const queued = await env.DB.prepare(`SELECT id, status FROM webhook_deliveries WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(botId)
    .first<{ id: string; status: string }>();
  if (queued?.status !== "failed" || !queued.id) throw new Error(`expected a failed delivery for ${botId}`);
  return queued.id;
}

async function reopen(id: string): Promise<void> {
  await env.DB.prepare(`UPDATE webhook_deliveries SET status = 'failed', updated_at = ? WHERE id = ?`)
    .bind("2000-01-01T00:00:00.000Z", id)
    .run();
}

async function deliveryStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT status FROM webhook_deliveries WHERE id = ?`).bind(id).first<{ status: string }>();
  return row?.status;
}
