import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rotateBotKey, setBotWebhook } from "../src/db";
import worker from "../src/index";
import { saveInboundPolicy } from "../src/inbound-security";
import { setDeliveryFetch } from "../src/webhook";
import { adminRequest, deliver, mcpCall, rawMime } from "./helpers";

async function captureStamp(fromBot: string, to: string, subject: string, text: string): Promise<string> {
  const key = await rotateBotKey(env, fromBot);
  const email = env.EMAIL as { send: (message: { headers?: Record<string, string> }) => Promise<{ messageId: string }> };
  const original = email.send;
  let stamp = "";
  try {
    email.send = async (message) => {
      stamp = message.headers?.["X-BotMail-Stamp"] ?? stamp;
      return { messageId: `<sent-${crypto.randomUUID()}@bots.example.test>` };
    };
    const sent = (await mcpCall(key, "send_email", { to: [to], subject, text })) as { status: string };
    expect(sent.status).toBe("sent");
  } finally {
    email.send = original;
  }
  expect(stamp.startsWith("v1 ")).toBe(true);
  return stamp;
}

const CLOUDFLARE_RECEIVED = "Received: from bg-bbi.cloudflare-smtp.net by cloudflare-email.net id test";

function scored(score: string | null, messageId: string, from: string, subject: string, text: string): string {
  const mime = rawMime({ from, to: "post@bots.example.test", subject, text, messageId });
  const scoreLine = score == null ? "" : `X-CF-SpamH-Score: ${score}\r\n`;
  return `${CLOUDFLARE_RECEIVED}\r\n${scoreLine}${mime}`;
}

async function stored(messageId: string): Promise<{
  id: string;
  folder: string;
  spam_score: number | null;
  is_read: number;
  quarantine_reason: string | null;
  auth_result: string;
}> {
  const row = await env.DB.prepare(
    `SELECT id, folder, spam_score, is_read, quarantine_reason, auth_result FROM messages WHERE message_id_header = ?`,
  )
    .bind(messageId)
    .first<{
      id: string;
      folder: string;
      spam_score: number | null;
      is_read: number;
      quarantine_reason: string | null;
      auth_result: string;
    }>();
  if (!row) throw new Error(`missing ${messageId}`);
  return row;
}

describe("junk folder", () => {
  it("hides junk from search and get_message unless include_junk is set", async () => {
    const messageId = "<junk-hidden-tools@notlisted.test>";
    const subject = "JunkNeedleHidden";
    await deliver(
      scored("5", messageId, "needle@notlisted.test", subject, "spammy body"),
      "needle@notlisted.test",
      "post@bots.example.test",
    );
    const row = await stored(messageId);
    expect(row.folder).toBe("junk");
    const key = await rotateBotKey(env, "post");
    const hidden = (await mcpCall(key, "search_messages", { query: subject })) as { messages: Array<{ id: string }> };
    expect(hidden.messages.some((item) => item.id === row.id)).toBe(false);
    await expect(mcpCall(key, "get_message", { message_id: row.id })).rejects.toThrow(/^Message not found$/);
    const found = (await mcpCall(key, "search_messages", { query: subject, include_junk: true })) as {
      messages: Array<{ id: string }>;
    };
    expect(found.messages.some((item) => item.id === row.id)).toBe(true);
    const message = (await mcpCall(key, "get_message", { message_id: row.id, include_junk: true })) as {
      id: string;
      folder: string;
    };
    expect(message).toMatchObject({ id: row.id, folder: "junk" });
  });

  it("files a score at the threshold in junk, keeps a lower score in the inbox, and honors off", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "post", "https://hooks.example.test/post-junk", "post-junk-key");
    const lowId = "<junk-score-1@notlisted.test>";
    const highId = "<junk-score-4@notlisted.test>";
    const offId = "<junk-score-off@notlisted.test>";
    try {
      await deliver(scored("1", lowId, "low@notlisted.test", "Low", "legit"), "low@notlisted.test", "post@bots.example.test");
      await deliver(scored("4", highId, "high@notlisted.test", "High", "spammy"), "high@notlisted.test", "post@bots.example.test");
      const low = await stored(lowId);
      const high = await stored(highId);
      expect(low).toMatchObject({ folder: "inbox", spam_score: 1, quarantine_reason: null });
      expect(high).toMatchObject({ folder: "junk", spam_score: 4, quarantine_reason: null });
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(low.id).first()).toBeTruthy();
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(high.id).first()).toBeNull();

      const key = await rotateBotKey(env, "post");
      const hidden = (await mcpCall(key, "list_messages", { from: "high@notlisted.test" })) as { messages: Array<{ id: string }> };
      const visible = (await mcpCall(key, "list_messages", { from: "low@notlisted.test" })) as { messages: Array<{ id: string }> };
      expect(hidden.messages.some((row) => row.id === high.id)).toBe(false);
      expect(visible.messages.some((row) => row.id === low.id)).toBe(true);
      const junked = (await mcpCall(key, "list_messages", { folder: "junk", from: "high@notlisted.test" })) as {
        messages: Array<{ id: string; spam_score: number | null }>;
      };
      expect(junked.messages.find((row) => row.id === high.id)?.spam_score).toBe(4);

      await saveInboundPolicy(env, { spamThreshold: "off" });
      await deliver(scored("5", offId, "off@notlisted.test", "Off", "kept"), "off@notlisted.test", "post@bots.example.test");
      const off = await stored(offId);
      expect(off).toMatchObject({ folder: "inbox", spam_score: 5 });
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(off.id).first()).toBeTruthy();
    } finally {
      await saveInboundPolicy(env, { source: "config" });
      setDeliveryFetch(null);
    }
  });

  it("keeps quarantine ahead of a high spam score", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "post", "https://hooks.example.test/post-junk-q", "post-junk-q");
    const messageId = "<junk-quarantine@bots.example.test>";
    try {
      await deliver(
        scored("5", messageId, "Herald <herald@bots.example.test>", "Claim", "unstamped"),
        "herald@bots.example.test",
        "post@bots.example.test",
      );
      const row = await stored(messageId);
      expect(row).toMatchObject({ folder: "quarantine", spam_score: 5, quarantine_reason: "unstamped internal sender" });
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row.id).first()).toBeNull();
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("moves junk to the inbox unread and then wakes the bot", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "post", "https://hooks.example.test/post-not-junk", "post-not-junk");
    const messageId = "<not-junk@notlisted.test>";
    try {
      await deliver(scored("5", messageId, "held@notlisted.test", "Held", "review"), "held@notlisted.test", "post@bots.example.test");
      const row = await stored(messageId);
      expect(row.folder).toBe("junk");
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row.id).first()).toBeNull();
      await env.DB.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(row.id).run();
      const response = await worker.fetch(
        await adminRequest(`/admin/api/mail/${row.id}/not-junk`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bot-mail-action": "1" },
          body: "{}",
        }),
        env,
      );
      expect(response.status).toBe(200);
      const after = await env.DB.prepare(`SELECT folder, status, is_read, spam_score FROM messages WHERE id = ?`)
        .bind(row.id)
        .first<{ folder: string; status: string; is_read: number; spam_score: number }>();
      expect(after).toEqual({ folder: "inbox", status: "received", is_read: 0, spam_score: 5 });
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row.id).first()).toBeTruthy();
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("stores null when the score is missing, unparseable, or outside the block, and keeps Cloudflare's score when a lower copy sits below it", async () => {
    const missingId = "<junk-missing@notlisted.test>";
    const badId = "<junk-bad@notlisted.test>";
    const duplicateId = "<junk-duplicate@notlisted.test>";
    const outsideId = "<junk-outside@notlisted.test>";
    await deliver(scored(null, missingId, "plain@notlisted.test", "Plain", "no header"), "plain@notlisted.test", "post@bots.example.test");
    await deliver(scored("nope", badId, "bad@notlisted.test", "Bad", "not a score"), "bad@notlisted.test", "post@bots.example.test");
    await deliver(
      `${CLOUDFLARE_RECEIVED}\r\nX-CF-SpamH-Score: 5\r\nX-CF-SpamH-Score: 1\r\n${rawMime({
        from: "dup@notlisted.test",
        to: "post@bots.example.test",
        subject: "Duplicate",
        text: "two scores",
        messageId: duplicateId,
      })}`,
      "dup@notlisted.test",
      "post@bots.example.test",
    );
    const outsideMime = rawMime({
      from: "out@notlisted.test",
      to: "post@bots.example.test",
      subject: "Outside",
      text: "below the block",
      messageId: outsideId,
    });
    const fromLine = outsideMime.slice(0, outsideMime.indexOf("\r\n"));
    await deliver(
      `${CLOUDFLARE_RECEIVED}\r\n${fromLine}\r\nX-CF-SpamH-Score: 5\r\n${outsideMime.slice(fromLine.length + 2)}`,
      "out@notlisted.test",
      "post@bots.example.test",
    );
    expect(await stored(missingId)).toMatchObject({ folder: "inbox", spam_score: null });
    expect(await stored(badId)).toMatchObject({ folder: "inbox", spam_score: null });
    expect(await stored(duplicateId)).toMatchObject({ folder: "junk", spam_score: 5 });
    expect(await stored(outsideId)).toMatchObject({ folder: "inbox", spam_score: null });
  });

  it("keeps stamped BotMail mail in the inbox when the score is high", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "post", "https://hooks.example.test/post-stamp-junk", "post-stamp-junk");
    const subject = "Stamped junk score";
    const text = "internal stays";
    const messageId = "<junk-stamped@bots.example.test>";
    try {
      const stamp = await captureStamp("aegis", "post@bots.example.test", subject, text);
      const raw = `${CLOUDFLARE_RECEIVED}\r\nX-CF-SpamH-Score: 5\r\nX-BotMail-Stamp: ${stamp}\r\n${rawMime({
        from: "Aegis <aegis@bots.example.test>",
        to: "post@bots.example.test",
        subject,
        text,
        messageId,
      })}`;
      await deliver(raw, "aegis@bots.example.test", "post@bots.example.test");
      const row = await stored(messageId);
      expect(row).toMatchObject({ folder: "inbox", spam_score: 5, auth_result: "internal", quarantine_reason: null });
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row.id).first()).toBeTruthy();
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("wakes once for not junk, and skips a disabled bot or a message that is not junk", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "post", "https://hooks.example.test/post-not-junk-guard", "post-not-junk-guard");
    const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };
    const postNotJunk = (id: string) =>
      adminRequest(`/admin/api/mail/${id}/not-junk`, { method: "POST", headers, body: "{}" }).then((request) => worker.fetch(request, env));
    try {
      const inboxId = "<not-junk-inbox@notlisted.test>";
      await deliver(scored("1", inboxId, "inbox@notlisted.test", "Inbox", "stays"), "inbox@notlisted.test", "post@bots.example.test");
      const inbox = await stored(inboxId);
      const wakesBefore = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE message_id = ?`)
        .bind(inbox.id)
        .first<{ n: number }>();
      const rejected = await postNotJunk(inbox.id);
      expect(rejected.status).toBe(400);
      expect((await stored(inboxId)).folder).toBe("inbox");
      const wakesAfter = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE message_id = ?`)
        .bind(inbox.id)
        .first<{ n: number }>();
      expect(wakesAfter?.n).toBe(wakesBefore?.n);

      const disabledId = "<not-junk-disabled@notlisted.test>";
      await deliver(scored("5", disabledId, "off@notlisted.test", "Disabled", "held"), "off@notlisted.test", "post@bots.example.test");
      const disabled = await stored(disabledId);
      expect(disabled.folder).toBe("junk");
      await env.DB.prepare(`UPDATE bots SET enabled = 0 WHERE id = 'post'`).run();
      const moved = await postNotJunk(disabled.id);
      expect(moved.status).toBe(200);
      expect((await stored(disabledId)).folder).toBe("inbox");
      expect(await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(disabled.id).first()).toBeNull();
      await env.DB.prepare(`UPDATE bots SET enabled = 1 WHERE id = 'post'`).run();

      const raceId = "<not-junk-race@notlisted.test>";
      await deliver(scored("5", raceId, "race@notlisted.test", "Race", "once"), "race@notlisted.test", "post@bots.example.test");
      const race = await stored(raceId);
      const [first, second] = await Promise.all([postNotJunk(race.id), postNotJunk(race.id)]);
      expect([first.status, second.status].sort()).toEqual([200, 400]);
      const wakes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE message_id = ?`)
        .bind(race.id)
        .first<{ n: number }>();
      expect(wakes?.n).toBe(1);
      expect((await stored(raceId)).folder).toBe("inbox");
    } finally {
      await env.DB.prepare(`UPDATE bots SET enabled = 1 WHERE id = 'post'`).run();
      setDeliveryFetch(null);
    }
  });
});
