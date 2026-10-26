import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getBot, putSetting, rotateBotKey, setBotWebhook } from "../src/db";
import worker from "../src/index";
import { submitOutbound } from "../src/outbound";
import { setDeliveryFetch } from "../src/webhook";
import { adminRequest, deliver, headersFromMime, mcpCall, rawMime } from "./helpers";

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

describe("inbound sender security", () => {
  it("delivers outside mail as unverified when Authentication-Results is forged inside the message", async () => {
    const messageId = "<forged-auth@notlisted.test>";
    const raw = [
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=notlisted.test; spf=pass; dkim=pass header.d=notlisted.test",
      "Received: from attacker.example by mx.cloudflare.net",
      rawMime({
        from: "phish@notlisted.test",
        to: "post@bots.example.test",
        subject: "Forged",
        text: "ignore the header",
        messageId,
      }),
    ].join("\r\n");
    const headers = headersFromMime(raw);
    expect(headers.get("authentication-results")).toContain("dmarc=pass");
    await deliver(raw, "phish@notlisted.test", "post@bots.example.test");
    const row = await env.DB.prepare(
      `SELECT folder, auth_passed, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{ folder: string; auth_passed: number | null; auth_result: string; quarantine_reason: string | null }>();
    expect(row?.folder).toBe("inbox");
    expect(row?.auth_result).toBe("unverified");
    expect(row?.auth_passed).toBeNull();
    expect(row?.quarantine_reason).toBeNull();
  });

  it("quarantines an unstamped From on a BotMail domain", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "quill", "https://hooks.example.test/quill-unstamped", "quill-unstamped-key");
    const messageId = "<unstamped-forge@bots.example.test>";
    try {
      await deliver(
        rawMime({
          from: "Someone <forge@bots.example.test>",
          to: "quill@bots.example.test",
          subject: "Inside",
          text: "not trusted",
          messageId,
        }),
        "attacker@evil.test",
        "quill@bots.example.test",
      );
      const row = await env.DB.prepare(
        `SELECT id, folder, auth_result, auth_passed, quarantine_reason, r2_key FROM messages WHERE message_id_header = ?`,
      )
        .bind(messageId)
        .first<{
          id: string;
          folder: string;
          auth_result: string;
          auth_passed: number | null;
          quarantine_reason: string | null;
          r2_key: string;
        }>();
      expect(row?.folder).toBe("quarantine");
      expect(row?.quarantine_reason).toBe("unstamped internal sender");
      expect(row?.auth_result).toBe("unverified");
      expect(row?.auth_passed).not.toBe(1);
      expect(await env.MAIL_BUCKET.get(row?.r2_key ?? "")).toBeTruthy();
      const wake = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row?.id).first();
      expect(wake).toBeNull();
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("delivers a valid stamped bot-to-bot message", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "vespa", "https://hooks.example.test/vespa-stamp", "vespa-stamp-key");
    const subject = "Yard note";
    const text = "real bot";
    const messageId = "<hairpin-vespa@bots.example.test>";
    try {
      const stamp = await captureStamp("aegis", "vespa@bots.example.test", subject, text);
      const raw = `X-BotMail-Stamp: ${stamp}\r\n${rawMime({
        from: "Aegis <aegis@bots.example.test>",
        to: "vespa@bots.example.test",
        subject,
        text,
        messageId,
      })}`;
      await deliver(raw, "aegis@bots.example.test", "vespa@bots.example.test");
      const row = await env.DB.prepare(
        `SELECT id, folder, auth_result, auth_passed, quarantine_reason, r2_key FROM messages WHERE message_id_header = ?`,
      )
        .bind(messageId)
        .first<{
          id: string;
          folder: string;
          auth_result: string;
          auth_passed: number | null;
          quarantine_reason: string | null;
          r2_key: string;
        }>();
      expect(row).toMatchObject({ folder: "inbox", auth_result: "internal", auth_passed: 1, quarantine_reason: null });
      const wake = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(row?.id).first();
      expect(wake).toBeTruthy();
      const stored = await env.MAIL_BUCKET.get(row?.r2_key ?? "");
      const eml = (await stored?.text()) ?? "";
      expect(eml.toLowerCase()).not.toContain("x-botmail-stamp");
      expect(eml).toContain(text);
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("rejects a replayed stamp when the body changes", async () => {
    const subject = "Replay note";
    const text = "original body";
    const stamp = await captureStamp("aegis", "post@bots.example.test", subject, text);
    const firstId = "<replay-original@bots.example.test>";
    const replayId = "<replay-changed@bots.example.test>";
    const mime = (messageId: string, body: string) =>
      `X-BotMail-Stamp: ${stamp}\r\n${rawMime({
        from: "Aegis <aegis@bots.example.test>",
        to: "post@bots.example.test",
        subject,
        text: body,
        messageId,
      })}`;
    await deliver(mime(firstId, text), "aegis@bots.example.test", "post@bots.example.test");
    await deliver(mime(replayId, "original body edited"), "aegis@bots.example.test", "post@bots.example.test");
    const original = await env.DB.prepare(`SELECT folder, auth_result FROM messages WHERE message_id_header = ?`)
      .bind(firstId)
      .first<{ folder: string; auth_result: string }>();
    const replay = await env.DB.prepare(`SELECT folder, quarantine_reason, auth_result FROM messages WHERE message_id_header = ?`)
      .bind(replayId)
      .first<{ folder: string; quarantine_reason: string | null; auth_result: string }>();
    expect(original).toEqual({ folder: "inbox", auth_result: "internal" });
    expect(replay).toEqual({ folder: "quarantine", quarantine_reason: "unstamped internal sender", auth_result: "unverified" });
  });

  it("delivers normal outside mail as unverified", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await setBotWebhook(env, "alexandria", "https://hooks.example.test/alexandria-outside", "alexandria-outside-key");
    const messageId = "<outside-plain@example.com>";
    try {
      await deliver(
        rawMime({
          from: "Ada <ada@example.com>",
          to: "alexandria@bots.example.test",
          subject: "Outside",
          text: "ordinary mail",
          messageId,
        }),
        "ada@example.com",
        "alexandria@bots.example.test",
      );
      const row = await env.DB.prepare(
        `SELECT id, folder, auth_passed, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`,
      )
        .bind(messageId)
        .first<{ id: string; folder: string; auth_passed: number | null; auth_result: string; quarantine_reason: string | null }>();
      expect(row?.folder).toBe("inbox");
      expect(row?.auth_result).toBe("unverified");
      expect(row?.auth_passed).toBeNull();
      expect(row?.quarantine_reason).toBeNull();
      const wake = await env.DB.prepare(`SELECT payload FROM webhook_deliveries WHERE message_id = ?`)
        .bind(row?.id)
        .first<{ payload: string }>();
      const payload = JSON.parse(wake?.payload ?? "{}") as { auth_result?: string; claims_owner_domain?: boolean };
      expect(payload.auth_result).toBe("unverified");
      expect(payload.claims_owner_domain).toBe(true);
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("quarantines unstamped comment, group, and subdomain From forms", async () => {
    const cases = [
      { id: "<comment-from@bots.example.test>", from: "herald@bots.example.test (Herald)" },
      { id: "<group-from@bots.example.test>", from: "Bots: herald@bots.example.test;" },
      { id: "<subdomain-from@bots.example.test>", from: "x@sub.bots.example.test" },
    ];
    for (const item of cases) {
      await deliver(
        rawMime({
          from: item.from,
          to: "quill@bots.example.test",
          subject: "Odd from",
          text: "unstamped",
          messageId: item.id,
        }),
        "attacker@outside.test",
        "quill@bots.example.test",
      );
      const row = await env.DB.prepare(`SELECT folder, from_addr, quarantine_reason, auth_result FROM messages WHERE message_id_header = ?`)
        .bind(item.id)
        .first<{ folder: string; from_addr: string; quarantine_reason: string | null; auth_result: string }>();
      expect(row?.folder).toBe("quarantine");
      expect(row?.quarantine_reason).toBe("unstamped internal sender");
      expect(row?.auth_result).not.toBe("internal");
      expect(row?.from_addr).toBe(item.id.includes("subdomain") ? "x@sub.bots.example.test" : "herald@bots.example.test");
    }
  });

  it("rate-limits a stamped bot pair above the pair cap", async () => {
    const mutable = env as Env;
    const previous = mutable.INBOUND_BOT_RATE_LIMIT;
    mutable.INBOUND_BOT_RATE_LIMIT = "2";
    try {
      for (const [index, messageId] of ["<pair-1@bots.example.test>", "<pair-2@bots.example.test>", "<pair-3@bots.example.test>"].entries()) {
        const subject = `Pair ${index + 1}`;
        const text = `pair body ${index + 1}`;
        const stamp = await captureStamp("aegis", "glyph@bots.example.test", subject, text);
        await deliver(
          `X-BotMail-Stamp: ${stamp}\r\n${rawMime({
            from: "Aegis <aegis@bots.example.test>",
            to: "glyph@bots.example.test",
            subject,
            text,
            messageId,
          })}`,
          "aegis@bots.example.test",
          "glyph@bots.example.test",
        );
      }
      const stored = (messageId: string) =>
        env.DB.prepare(`SELECT folder, quarantine_reason, auth_result FROM messages WHERE message_id_header = ?`)
          .bind(messageId)
          .first<{ folder: string; quarantine_reason: string | null; auth_result: string }>();
      expect(await stored("<pair-1@bots.example.test>")).toEqual({ folder: "inbox", quarantine_reason: null, auth_result: "internal" });
      expect(await stored("<pair-2@bots.example.test>")).toEqual({ folder: "inbox", quarantine_reason: null, auth_result: "internal" });
      expect(await stored("<pair-3@bots.example.test>")).toEqual({
        folder: "quarantine",
        quarantine_reason: "rate limited",
        auth_result: "internal",
      });
    } finally {
      mutable.INBOUND_BOT_RATE_LIMIT = previous;
    }
  });

  it("quarantines mail over the per-sender hourly limit", async () => {
    const mutable = env as Env;
    const previous = mutable.INBOUND_RATE_LIMIT;
    mutable.INBOUND_RATE_LIMIT = "2";
    try {
      for (const [index, messageId] of ["<rate-1@example.test>", "<rate-2@example.test>", "<rate-3@example.test>"].entries()) {
        await deliver(
          rawMime({
            from: "flood@outside.test",
            to: "alexandria@bots.example.test",
            subject: `Flood ${index + 1}`,
            text: "again",
            messageId,
          }),
          "flood@outside.test",
          "alexandria@bots.example.test",
        );
      }
      const stored = (messageId: string) =>
        env.DB.prepare(`SELECT folder, quarantine_reason FROM messages WHERE message_id_header = ?`)
          .bind(messageId)
          .first<{ folder: string; quarantine_reason: string | null }>();
      expect(await stored("<rate-1@example.test>")).toEqual({ folder: "inbox", quarantine_reason: null });
      expect(await stored("<rate-2@example.test>")).toEqual({ folder: "inbox", quarantine_reason: null });
      expect(await stored("<rate-3@example.test>")).toEqual({ folder: "quarantine", quarantine_reason: "rate limited" });
    } finally {
      mutable.INBOUND_RATE_LIMIT = previous;
    }
  });

  it("quarantines a blocklist hit without deleting it, lets an allowlist sender through, and releases", async () => {
    setDeliveryFetch(async () => new Response(null, { status: 204 }));
    await putSetting(env, "inbound_blocklist", JSON.stringify(["evil.test"]));
    await setBotWebhook(env, "vespa", "https://hooks.example.test/vespa-block", "vespa-block-key");
    const blockedId = "<blocked@evil.test>";
    try {
      await deliver(
        rawMime({
          from: "blocked@evil.test",
          to: "vespa@bots.example.test",
          subject: "Blocked",
          text: "kept",
          messageId: blockedId,
        }),
        "blocked@evil.test",
        "vespa@bots.example.test",
      );
      const blocked = await env.DB.prepare(`SELECT id, folder, r2_key, quarantine_reason FROM messages WHERE message_id_header = ?`)
        .bind(blockedId)
        .first<{ id: string; folder: string; r2_key: string; quarantine_reason: string }>();
      expect(blocked).toMatchObject({ folder: "quarantine", quarantine_reason: "blocked" });
      expect(blocked?.r2_key).toBeTruthy();
      expect(await env.MAIL_BUCKET.get(blocked?.r2_key ?? "")).toBeTruthy();

      await putSetting(env, "inbound_allowlist", JSON.stringify(["partner.test"]));
      const allowedId = "<friend@partner.test>";
      await deliver(
        rawMime({
          from: "friend@partner.test",
          to: "vespa@bots.example.test",
          subject: "Allowed",
          text: "in",
          messageId: allowedId,
        }),
        "friend@partner.test",
        "vespa@bots.example.test",
      );
      const allowed = await env.DB.prepare(`SELECT folder, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`)
        .bind(allowedId)
        .first<{ folder: string; auth_result: string; quarantine_reason: string | null }>();
      expect(allowed).toEqual({ folder: "inbox", auth_result: "unverified", quarantine_reason: null });

      const released = await worker.fetch(
        await adminRequest(`/admin/api/mail/${blocked?.id}/release`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bot-mail-action": "1" },
          body: "{}",
        }),
        env,
      );
      expect(released.status).toBe(200);
      const after = await env.DB.prepare(`SELECT folder, status, quarantine_reason FROM messages WHERE id = ?`)
        .bind(blocked?.id)
        .first<{ folder: string; status: string; quarantine_reason: string | null }>();
      expect(after).toEqual({ folder: "inbox", status: "received", quarantine_reason: null });
      const delivery = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE message_id = ?`).bind(blocked?.id).first();
      expect(delivery).toBeTruthy();
      const stillThere = await env.DB.prepare(`SELECT id FROM messages WHERE id = ?`).bind(blocked?.id).first();
      expect(stillThere).toBeTruthy();
    } finally {
      setDeliveryFetch(null);
    }
  });

  it("lets a long human-approved thread through", async () => {
    const bot = await getBot(env, "vista");
    if (!bot) throw new Error("vista missing");
    const email = env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
    const original = email.send;
    try {
      let inReplyTo: string | null = null;
      for (let n = 0; n < 11; n += 1) {
        const messageId = `<approved-${n}-${crypto.randomUUID()}@bots.example.test>`;
        email.send = async () => ({ messageId });
        const sent = await submitOutbound(
          env,
          bot,
          {
            to: ["athena@bots.example.test"],
            subject: n === 0 ? "Approved thread" : "Re: Approved thread",
            text: `approved reply ${n}`,
            inReplyTo,
          },
          "admin",
        );
        expect(sent.status).toBe("sent");
        inReplyTo = messageId;
      }
    } finally {
      email.send = original;
    }
    const hops = await env.DB.prepare(
      `SELECT MAX(hop_count) AS hop FROM messages WHERE bot_id = 'vista' AND direction = 'out' AND text_body LIKE 'approved reply %'`,
    ).first<{ hop: number }>();
    expect(hops?.hop).toBe(0);
  });

  it("stops an automated ping-pong inside the reply window", async () => {
    const mutable = env as { INBOUND_AUTO_REPLY_LIMIT?: string };
    const previous = mutable.INBOUND_AUTO_REPLY_LIMIT;
    mutable.INBOUND_AUTO_REPLY_LIMIT = "1";
    const email = env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
    const original = email.send;
    try {
      email.send = async () => ({ messageId: `<auto-${crypto.randomUUID()}@bots.example.test>` });
      const forgeKey = await rotateBotKey(env, "forge");
      const argusKey = await rotateBotKey(env, "argus");
      const first = (await mcpCall(forgeKey, "send_email", {
        to: ["argus@bots.example.test"],
        subject: "ping",
        text: "one",
        automated: true,
      })) as { status: string };
      const second = (await mcpCall(argusKey, "send_email", {
        to: ["forge@bots.example.test"],
        subject: "pong",
        text: "two",
        automated: true,
      })) as { status: string };
      const third = (await mcpCall(forgeKey, "send_email", {
        to: ["argus@bots.example.test"],
        subject: "ping again",
        text: "three",
        automated: true,
      })) as { status: string; error?: string };
      expect(first.status).toBe("sent");
      expect(second.status).toBe("sent");
      expect(third.status).toBe("failed");
      expect(third.error).toContain("Auto-reply loop");
    } finally {
      email.send = original;
      mutable.INBOUND_AUTO_REPLY_LIMIT = previous;
    }
  });

  it("ignores a hop header set by an outside sender", async () => {
    const messageId = "<outsider-hop@example.com>";
    const raw = [
      "X-BotMail-Hops: 10",
      "Auto-Submitted: auto-generated",
      rawMime({
        from: "Ada <ada@example.com>",
        to: "eggbot@bots.example.test",
        subject: "Hop",
        text: "not a loop",
        messageId,
      }),
    ].join("\r\n");
    await deliver(raw, "ada@example.com", "eggbot@bots.example.test");
    const row = await env.DB.prepare(`SELECT folder, hop_count, quarantine_reason FROM messages WHERE message_id_header = ?`)
      .bind(messageId)
      .first<{ folder: string; hop_count: number; quarantine_reason: string | null }>();
    expect(row).toEqual({ folder: "inbox", hop_count: 0, quarantine_reason: null });

    const bot = await getBot(env, "eggbot");
    if (!bot) throw new Error("eggbot missing");
    const email = env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
    const original = email.send;
    try {
      email.send = async () => ({ messageId: `<egg-reply-${crypto.randomUUID()}@bots.example.test>` });
      const sent = await submitOutbound(
        env,
        bot,
        {
          to: ["vista@bots.example.test"],
          subject: "Re: Hop",
          text: "person asked",
          inReplyTo: messageId,
        },
        "bot",
      );
      expect(sent.status).toBe("sent");
      const outbound = await env.DB.prepare(`SELECT hop_count FROM messages WHERE id = ?`)
        .bind(sent.message_id)
        .first<{ hop_count: number }>();
      expect(outbound?.hop_count).toBe(1);
    } finally {
      email.send = original;
    }
  });

  it("quarantines lookalike BotMail domains and delivers an ordinary internationalized domain", async () => {
    const cases = [
      { id: "<cyrillic-from@lookalike.test>", from: "herald@b\u043ets.example.test", reason: "unstamped internal sender" },
      { id: "<puny-from@lookalike.test>", from: "herald@xn--bts-sed.example.test", reason: "unstamped internal sender" },
      { id: "<percent-from@lookalike.test>", from: "herald%bots.example.test@evil.test", reason: "unparsed sender" },
      { id: "<armenian-from@lookalike.test>", from: "herald@b\u0585ts.example.test", reason: "unstamped internal sender" },
      { id: "<digit-from@lookalike.test>", from: "herald@b0ts.example.test", reason: "unstamped internal sender" },
      { id: "<idn-ok@munchen.example>", from: "user@münchen.example", reason: null },
    ];
    for (const item of cases) {
      await deliver(
        rawMime({
          from: item.from,
          to: "post@bots.example.test",
          subject: item.id,
          text: "lookalike",
          messageId: item.id,
        }),
        "attacker@evil.test",
        "post@bots.example.test",
      );
      const row = await env.DB.prepare(`SELECT folder, quarantine_reason, auth_result FROM messages WHERE message_id_header = ?`)
        .bind(item.id)
        .first<{ folder: string; quarantine_reason: string | null; auth_result: string }>();
      if (item.reason) {
        expect(row?.folder).toBe("quarantine");
        expect(row?.quarantine_reason).toBe(item.reason);
        expect(row?.auth_result).not.toBe("internal");
      } else {
        expect(row).toEqual({ folder: "inbox", quarantine_reason: null, auth_result: "unverified" });
      }
    }
  });

  it("delivers a sender with an apostrophe in the local part", async () => {
    const messageId = "<obrien-sender@example.com>";
    await deliver(
      rawMime({
        from: "O'Brien <o'brien@example.com>",
        to: "athena@bots.example.test",
        subject: "Apostrophe",
        text: "hello",
        messageId,
      }),
      "o'brien@example.com",
      "athena@bots.example.test",
    );
    const row = await env.DB.prepare(
      `SELECT folder, from_addr, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{ folder: string; from_addr: string; auth_result: string; quarantine_reason: string | null }>();
    expect(row).toEqual({
      folder: "inbox",
      from_addr: "o'brien@example.com",
      auth_result: "unverified",
      quarantine_reason: null,
    });
  });

  it("counts a plus-tag recipient toward the auto-reply limit", async () => {
    const mutable = env as { INBOUND_AUTO_REPLY_LIMIT?: string };
    const previous = mutable.INBOUND_AUTO_REPLY_LIMIT;
    mutable.INBOUND_AUTO_REPLY_LIMIT = "1";
    const email = env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
    const original = email.send;
    try {
      email.send = async () => ({ messageId: `<plus-${crypto.randomUUID()}@bots.example.test>` });
      const key = await rotateBotKey(env, "quill");
      const first = (await mcpCall(key, "send_email", {
        to: ["alexandria@bots.example.test"],
        subject: "plus",
        text: "one",
      })) as { status: string; message_id: string };
      const second = (await mcpCall(key, "send_email", {
        to: ["alexandria+notes@bots.example.test"],
        subject: "plus tag",
        text: "two",
      })) as { status: string; error?: string };
      expect(first.status).toBe("sent");
      expect(second.status).toBe("failed");
      expect(second.error).toContain("Auto-reply loop");
      const hop = await env.DB.prepare(`SELECT hop_count FROM messages WHERE id = ?`).bind(first.message_id).first<{ hop_count: number }>();
      expect(hop?.hop_count).toBeGreaterThan(0);
    } finally {
      email.send = original;
      mutable.INBOUND_AUTO_REPLY_LIMIT = previous;
    }
  });

  it("counts a bot-to-bot send that does not set the automated flag", async () => {
    const mutable = env as { INBOUND_AUTO_REPLY_LIMIT?: string };
    const previous = mutable.INBOUND_AUTO_REPLY_LIMIT;
    mutable.INBOUND_AUTO_REPLY_LIMIT = "1";
    const email = env.EMAIL as { send: (message: unknown) => Promise<{ messageId: string }> };
    const original = email.send;
    try {
      email.send = async () => ({ messageId: `<plain-${crypto.randomUUID()}@bots.example.test>` });
      const key = await rotateBotKey(env, "post");
      const first = (await mcpCall(key, "send_email", {
        to: ["vespa@bots.example.test"],
        subject: "plain",
        text: "one",
      })) as { status: string; message_id: string };
      const second = (await mcpCall(key, "send_email", {
        to: ["vespa@bots.example.test"],
        subject: "plain again",
        text: "two",
      })) as { status: string; error?: string };
      expect(first.status).toBe("sent");
      const hop = await env.DB.prepare(`SELECT hop_count FROM messages WHERE id = ?`).bind(first.message_id).first<{ hop_count: number }>();
      expect(hop?.hop_count).toBeGreaterThan(0);
      expect(second.status).toBe("failed");
      expect(second.error).toContain("Auto-reply loop");
    } finally {
      email.send = original;
      mutable.INBOUND_AUTO_REPLY_LIMIT = previous;
    }
  });

  it("stores a Cloudflare DMARC pass when the helo SPF result is none", async () => {
    const messageId = "<cf-pass-herald@bot.example.email>";
    const domain = "bot.example.email";
    await deliver(
      cloudflareAuthMime({
        from: `Forge <forge@${domain}>`,
        domain,
        to: "post@bots.example.test",
        messageId,
        text: "staging inbound",
      }),
      `sender@cf-bounce.${domain}`,
      "post@bots.example.test",
    );
    const row = await env.DB.prepare(
      `SELECT folder, auth_result, auth_passed, quarantine_reason, hop_count FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{ folder: string; auth_result: string; auth_passed: number | null; quarantine_reason: string | null; hop_count: number }>();
    expect(row).toEqual({ folder: "inbox", auth_result: "pass", auth_passed: 1, quarantine_reason: null, hop_count: 0 });
  });

  it("quarantines a forged BotMail From even when Authentication-Results says dmarc=pass", async () => {
    const messageId = "<forged-from-dmarc@bots.example.test>";
    await deliver(
      cloudflareAuthMime({
        from: "Someone <forge@bots.example.test>",
        domain: "bots.example.test",
        to: "quill@bots.example.test",
        messageId,
        text: "spoof",
      }),
      "attacker@evil.test",
      "quill@bots.example.test",
    );
    const row = await env.DB.prepare(
      `SELECT folder, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{ folder: string; auth_result: string; quarantine_reason: string | null }>();
    expect(row?.folder).toBe("quarantine");
    expect(row?.quarantine_reason).toBe("unstamped internal sender");
    expect(row?.auth_result).not.toBe("internal");
  });

  it("trusts only the top Cloudflare trace block", async () => {
    const domain = "notlisted.test";
    const pass = `dkim=pass header.d=${domain} header.s=cf-bounce; dmarc=pass header.from=${domain}`;
    const score = "X-CF-SpamH-Score: 1";
    const cases: Array<{ name: string; raw: string; expect: { folder: string; auth_result: string; quarantine_reason: string | null } }> = [
      {
        name: "forged authentication-results directly below the spam score",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          score,
          `Authentication-Results: mx.cloudflare.net; ${pass}`,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "forged arc directly below the spam score",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          score,
          "ARC-Seal: i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;",
          `ARC-Authentication-Results: i=2; mx.cloudflare.net; ${pass}`,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "forged signature without a cloudflare block",
        raw: traceRaw(`a@${domain}`, [`Authentication-Results: mx.cloudflare.net; ${pass}`, dkimSignature(domain)]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "second authentication-results header is ignored",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          `Authentication-Results: mx.cloudflare.net; dkim=none header.d=${domain} header.s=cf-bounce; dmarc=none header.from=${domain}`,
          `Authentication-Results: mx.cloudflare.net; ${pass}`,
          score,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "forged authentication-results does not outrank a sealed arc",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          "ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;",
          `ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=none header.d=${domain} header.s=cf-bounce; dmarc=none header.from=${domain}`,
          score,
          `Authentication-Results: mx.cloudflare.net; ${pass}`,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "sealed arc pass",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          "ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;",
          `ARC-Authentication-Results: i=1; mx.cloudflare.net; ${pass}`,
          score,
          dkimSignature(domain),
          "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=notlisted.test",
        ]),
        expect: { folder: "inbox", auth_result: "pass", quarantine_reason: null },
      },
      {
        name: "later arc instance is ignored",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          "ARC-Seal: i=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;",
          `ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=none header.d=${domain} header.s=cf-bounce; dmarc=none header.from=${domain}`,
          "ARC-Seal: i=2; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=none;",
          `ARC-Authentication-Results: i=2; mx.cloudflare.net; ${pass}`,
          score,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "quoted mailfrom cannot inject a method",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${domain}; spf=pass smtp.mailfrom="x; dkim=pass header.d=${domain} header.s=cf-bounce"@${domain}`,
          score,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "parenthesis in a commented local part cannot inject a method",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          `Authentication-Results: mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of a); ${pass} (designates 1.2.3.4 as permitted sender) smtp.mailfrom=a)b@${domain}`,
          score,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "quoted local part in a comment cannot inject a method",
        raw: traceRaw(`a@${domain}`, [
          receivedByCloudflare(),
          `Authentication-Results: mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of "a) ${pass}"@${domain} designates 1.2.3.4 as permitted sender) smtp.mailfrom="a)b"@${domain}`,
          score,
          dkimSignature(domain),
        ]),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
      {
        name: "multiple from",
        raw: traceRaw(`one@${domain}`, [receivedByCloudflare(), `Authentication-Results: mx.cloudflare.net; ${pass}`, score, dkimSignature(domain)], `One <one@${domain}>, Two <two@other.test>`),
        expect: { folder: "quarantine", auth_result: "unverified", quarantine_reason: "multiple from" },
      },
      {
        name: "unicode from matches punycode header",
        raw: traceRaw("a@münchen.test", [
          receivedByCloudflare(),
          "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=xn--mnchen-3ya.test header.s=cf-bounce; dmarc=pass header.from=xn--mnchen-3ya.test",
          score,
          dkimSignature("xn--mnchen-3ya.test"),
        ], "Person <a@münchen.test>"),
        expect: { folder: "inbox", auth_result: "pass", quarantine_reason: null },
      },
      {
        name: "public suffix does not align",
        raw: traceRaw("a@evil.github.io", [
          receivedByCloudflare(),
          "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=github.io header.s=cf-bounce; dmarc=pass header.from=github.io",
          score,
          dkimSignature("github.io"),
        ], "Person <a@evil.github.io>"),
        expect: { folder: "inbox", auth_result: "unverified", quarantine_reason: null },
      },
    ];
    for (const sample of cases) {
      const messageId = `<${sample.name.replaceAll(" ", "-")}@notlisted.test>`;
      const raw = sample.raw.replace("Message-ID: <trace@notlisted.test>", `Message-ID: ${messageId}`);
      await deliver(raw, "sender@notlisted.test", "post@bots.example.test");
      const row = await env.DB.prepare(
        `SELECT folder, auth_result, quarantine_reason FROM messages WHERE message_id_header = ?`,
      )
        .bind(messageId)
        .first<{ folder: string; auth_result: string; quarantine_reason: string | null }>();
      expect({ name: sample.name, ...row }).toEqual({ name: sample.name, ...sample.expect });
    }
  });
});

function receivedByCloudflare(): string {
  return "Received: from bg-bbi.cloudflare-smtp.net (104.30.16.118) by cloudflare-email.net (cloudflare) id test";
}

function dkimSignature(domain: string): string {
  return `DKIM-Signature: v=1; a=rsa-sha256; s=cf-bounce; d=${domain}; c=relaxed/relaxed; b=abc;`;
}

function traceRaw(address: string, headers: string[], from = `Person <${address}>`): string {
  return [
    ...headers,
    `From: ${from}`,
    "To: post@bots.example.test",
    "Subject: auth",
    "Date: Thu, 22 Oct 2026 12:10:00 +0000",
    "Message-ID: <trace@notlisted.test>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "body",
    "",
  ].join("\r\n");
}

/** The shape Cloudflare Email Routing added on the staging herald message, including spf=none for the helo. */
function cloudflareAuthMime(options: { from: string; domain: string; to: string; messageId: string; text: string }): string {
  const domain = options.domain;
  return [
    "Received: from bg-bbi.cloudflare-smtp.net (104.30.16.118)",
    "        by cloudflare-email.net (cloudflare) id test",
    `        for <${options.to}>; Thu, 22 Oct 2026 12:10:02 +0000`,
    "ARC-Authentication-Results: i=1; mx.cloudflare.net;",
    `        dkim=pass header.d=${domain} header.s=cf-bounce header.b=abc;`,
    "        dkim=pass header.d=cloudflare-smtp.net header.s=cf2024-1 header.b=def;",
    `        dmarc=pass header.from=${domain} policy.dmarc=quarantine;`,
    "        spf=none (mx.cloudflare.net: no SPF records found for postmaster@bg-bbi.cloudflare-smtp.net) smtp.helo=bg-bbi.cloudflare-smtp.net;",
    `        spf=pass (mx.cloudflare.net: domain of sender@cf-bounce.${domain} designates 104.30.16.118 as permitted sender) smtp.mailfrom=sender@cf-bounce.${domain};`,
    "        arc=none smtp.remote-ip=104.30.16.118",
    "Authentication-Results: mx.cloudflare.net;",
    `        dkim=pass header.d=${domain} header.s=cf-bounce header.b=abc;`,
    "        dkim=pass header.d=cloudflare-smtp.net header.s=cf2024-1 header.b=def;",
    `        dmarc=pass header.from=${domain} policy.dmarc=quarantine;`,
    "        spf=none (mx.cloudflare.net: no SPF records found for postmaster@bg-bbi.cloudflare-smtp.net) smtp.helo=bg-bbi.cloudflare-smtp.net;",
    `        spf=pass (mx.cloudflare.net: domain of sender@cf-bounce.${domain} designates 104.30.16.118 as permitted sender) smtp.mailfrom=sender@cf-bounce.${domain};`,
    "        arc=none smtp.remote-ip=104.30.16.118",
    "X-CF-SpamH-Score: 1",
    `DKIM-Signature: v=1; a=rsa-sha256; s=cf-bounce; d=${domain}; c=relaxed/relaxed; b=abc;`,
    "DKIM-Signature: v=1; a=rsa-sha256; s=cf2024-1; d=cloudflare-smtp.net; c=relaxed/relaxed; b=def;",
    `From: ${options.from}`,
    `To: ${options.to}`,
    "Subject: BotMail staging inbound test",
    "Date: Thu, 22 Oct 2026 12:10:00 +0000",
    `Message-ID: ${options.messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text,
    "",
  ].join("\r\n");
}
