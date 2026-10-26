import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { deliver, inboundMessage, rawMime } from "./helpers";

describe("inbound routing and storage", () => {
  it("stores a message for the bot local-part and keeps the raw eml", async () => {
    const messageId = "<inbound-forge@bots.example.test>";
    const raw = rawMime({
      from: "Ada <ada@example.com>",
      to: "Forge <forge@bots.example.test>",
      cc: "cc@example.com",
      subject: "Hull plating",
      text: "The plate is ready for review.",
      messageId,
    });
    const incoming = inboundMessage(raw, "ada@example.com", "forge@bots.example.test");
    await worker.email(incoming.message, env);
    expect(incoming.rejected()).toBeUndefined();

    const row = await env.DB.prepare(
      `SELECT bot_id, folder, direction, subject, from_addr, text_body, snippet, is_read, message_id_header, r2_key, cc_addrs
       FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{
        bot_id: string;
        folder: string;
        direction: string;
        subject: string;
        from_addr: string;
        text_body: string;
        snippet: string;
        is_read: number;
        r2_key: string;
        cc_addrs: string;
      }>();
    expect(row?.bot_id).toBe("forge");
    expect(row?.folder).toBe("inbox");
    expect(row?.direction).toBe("in");
    expect(row?.subject).toBe("Hull plating");
    expect(row?.from_addr).toBe("ada@example.com");
    expect(row?.text_body).toContain("plate is ready");
    expect(row?.snippet).toContain("plate is ready");
    expect(row?.is_read).toBe(0);
    expect(JSON.parse(row?.cc_addrs ?? "[]")).toEqual(["cc@example.com"]);
    expect(row?.r2_key).toMatch(/^forge\/2026\/10\/09\/.+\.eml$/);

    const object = await env.MAIL_BUCKET.get(row?.r2_key ?? "");
    expect(object).not.toBeNull();
    expect(await object?.text()).toContain("Hull plating");
  });

  it("routes plus-addressing to the base bot", async () => {
    const messageId = "<plus-forge@bots.example.test>";
    await deliver(
      rawMime({
        from: "clickup@example.com",
        to: "forge+clickup@bots.example.test",
        subject: "Task moved",
        text: "Status changed.",
        messageId,
      }),
      "clickup@example.com",
      "forge+clickup@bots.example.test",
    );
    const row = await env.DB.prepare(`SELECT bot_id, plus_tag, folder FROM messages WHERE message_id_header = ?`)
      .bind(messageId)
      .first<{ bot_id: string; plus_tag: string; folder: string }>();
    expect(row).toEqual({ bot_id: "forge", plus_tag: "clickup", folder: "inbox" });
  });

  it("files unknown recipients in _unrouted without rejecting", async () => {
    const messageId = "<nobody@bots.example.test>";
    const incoming = inboundMessage(
      rawMime({
        from: "ada@example.com",
        to: "nobody@bots.example.test",
        subject: "Wrong bot",
        text: "Is anyone there?",
        messageId,
      }),
      "ada@example.com",
      "nobody@bots.example.test",
    );
    await worker.email(incoming.message, env);
    expect(incoming.rejected()).toBeUndefined();
    const row = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`)
      .bind(messageId)
      .first<{ bot_id: string; folder: string }>();
    expect(row).toEqual({ bot_id: "_unrouted", folder: "_unrouted" });
    const listed = await env.MAIL_BUCKET.list({ prefix: "_unrouted/" });
    expect(listed.objects.length).toBeGreaterThan(0);
  });

  it("rejects mail for any domain other than MAIL_DOMAIN", async () => {
    const messageId = "<forge-other@example.com>";
    const incoming = inboundMessage(
      rawMime({
        from: "ada@example.com",
        to: "forge@other.example",
        subject: "Wrong domain",
        text: "Not this zone.",
        messageId,
      }),
      "ada@example.com",
      "forge@other.example",
    );
    await worker.email(incoming.message, env);
    expect(incoming.rejected()).toBe("Recipient domain is not a BotMail domain");
    const row = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`)
      .bind(messageId)
      .first<{ id: string }>();
    expect(row).toBeNull();
  });

  it("stores attachments beside the eml", async () => {
    const messageId = "<files@bots.example.test>";
    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "quill@bots.example.test",
        subject: "Notes",
        text: "See attached.",
        messageId,
        attachment: { filename: "note.txt", type: "text/plain", content: "hello attachment" },
      }),
      "ada@example.com",
      "quill@bots.example.test",
    );
    const row = await env.DB.prepare(
      `SELECT id, has_attachments, r2_key FROM messages WHERE message_id_header = ?`,
    )
      .bind(messageId)
      .first<{ id: string; has_attachments: number; r2_key: string }>();
    expect(row?.has_attachments).toBe(1);
    const attachment = await env.DB.prepare(
      `SELECT filename, r2_key, size_bytes FROM attachments WHERE message_id = ?`,
    )
      .bind(row?.id)
      .first<{ filename: string; r2_key: string; size_bytes: number }>();
    expect(attachment?.filename).toBe("note.txt");
    expect(attachment?.r2_key.startsWith(row?.r2_key.replace(/\.eml$/, "") ?? "missing")).toBe(true);
    const object = await env.MAIL_BUCKET.get(attachment?.r2_key ?? "");
    expect(await object?.text()).toBe("hello attachment");
  });

  it("dedupes a second delivery of the same Message-ID", async () => {
    const messageId = "<dup@bots.example.test>";
    const raw = rawMime({
      from: "ada@example.com",
      to: "glyph@bots.example.test",
      subject: "Once",
      text: "only once",
      messageId,
    });
    await deliver(raw, "ada@example.com", "glyph@bots.example.test");
    await deliver(raw, "ada@example.com", "glyph@bots.example.test");
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE message_id_header = ?`)
      .bind(messageId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects oversized messages", async () => {
    const incoming = inboundMessage("From: a@b.c\r\n\r\nhi", "a@b.c", "forge@bots.example.test", 26 * 1024 * 1024);
    await worker.email(incoming.message, env);
    expect(incoming.rejected()).toBe("Message too large");
  });
});
