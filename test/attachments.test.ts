import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE64_ATTACHMENT_CAP } from "../src/attachments";
import { rotateBotKey } from "../src/db";
import worker from "../src/index";
import { adminRequest, deliver, mcpCall } from "./helpers";

function mimeWithFiles(): string {
  const boundary = "botmailfiles";
  return [
    "From: ada@example.com",
    "To: quill@bots.example.test",
    "Subject: Files",
    "Date: Thu, 09 Oct 2026 12:00:00 +0000",
    "Message-ID: <files-both@bots.example.test>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See both.",
    `--${boundary}`,
    `Content-Type: text/plain; name="note.txt"`,
    `Content-Disposition: attachment; filename="note.txt"`,
    "Content-Transfer-Encoding: base64",
    "",
    btoa("hello attachment"),
    `--${boundary}`,
    `Content-Type: application/pdf; name="sheet.pdf"`,
    `Content-Disposition: attachment; filename="sheet.pdf"`,
    "Content-Transfer-Encoding: base64",
    "",
    btoa("PDF-BYTES"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

describe("attachments", () => {
  it("lists inbound files and returns text or base64 under the cap", async () => {
    await deliver(mimeWithFiles(), "ada@example.com", "quill@bots.example.test");
    const stored = await env.DB.prepare(`SELECT id, r2_key FROM messages WHERE message_id_header = ?`)
      .bind("<files-both@bots.example.test>")
      .first<{ id: string; r2_key: string }>();
    const key = await rotateBotKey(env, "quill");
    const listed = (await mcpCall(key, "list_attachments", { message_id: stored?.id ?? "" })) as {
      attachments: Array<{ id: string; filename: string; content_type: string }>;
    };
    const note = listed.attachments.find((item) => item.filename === "note.txt");
    const pdf = listed.attachments.find((item) => item.filename === "sheet.pdf");
    expect(note?.content_type).toContain("text/plain");
    expect(pdf?.content_type).toContain("application/pdf");

    const text = (await mcpCall(key, "get_attachment", { attachment_id: note?.id ?? "" })) as { text?: string; base64?: string };
    expect(text.text).toBe("hello attachment");
    expect(text.base64).toBeUndefined();
    const binary = (await mcpCall(key, "get_attachment", { attachment_id: pdf?.id ?? "" })) as {
      base64?: string;
      content_type: string;
      text?: string;
    };
    expect(binary.text).toBeUndefined();
    expect(binary.base64).toBe(btoa("PDF-BYTES"));
    expect(binary.content_type).toContain("application/pdf");

    const beside = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`).bind(note?.id).first<{ r2_key: string }>();
    expect(beside?.r2_key).toBe(`${stored?.r2_key.replace(/\.eml$/, "")}/attachments/1-note.txt`);

    await env.DB.prepare(`UPDATE attachments SET size_bytes = ? WHERE id = ?`).bind(BASE64_ATTACHMENT_CAP + 1, pdf?.id).run();
    await expect(mcpCall(key, "get_attachment", { attachment_id: pdf?.id ?? "" })).rejects.toThrow(
      `Attachment "sheet.pdf" is ${BASE64_ATTACHMENT_CAP + 1} bytes, over the ${BASE64_ATTACHMENT_CAP} byte cap`,
    );
  });

  it("stores send and reply attachments beside the sent eml", async () => {
    const key = await rotateBotKey(env, "aegis");
    const sent = (await mcpCall(key, "send_email", {
      to: ["vespa@bots.example.test"],
      subject: "With file",
      text: "see file",
      attachments: [{ filename: "note.txt", content_type: "text/plain", content_base64: btoa("sent file") }],
    })) as { status: string; message_id: string };
    expect(sent.status).toBe("sent");
    const sentRow = await env.DB.prepare(`SELECT r2_key FROM messages WHERE id = ?`).bind(sent.message_id).first<{ r2_key: string }>();
    const sentFile = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`).bind(sent.message_id).first<{ r2_key: string }>();
    expect(sentFile?.r2_key).toBe(`${sentRow?.r2_key.replace(/\.eml$/, "")}/attachments/1-note.txt`);
    expect(await (await env.MAIL_BUCKET.get(sentFile?.r2_key ?? ""))?.text()).toBe("sent file");

    const reply = (await mcpCall(key, "reply", {
      message_id: sent.message_id,
      text: "more",
      attachments: [{ filename: "more.txt", content_type: "text/plain", content_base64: btoa("reply file") }],
    })) as { status: string; message_id: string };
    expect(reply.status).toBe("sent");
    const replyRow = await env.DB.prepare(`SELECT r2_key FROM messages WHERE id = ?`).bind(reply.message_id).first<{ r2_key: string }>();
    const replyFile = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`).bind(reply.message_id).first<{ r2_key: string }>();
    expect(replyFile?.r2_key).toBe(`${replyRow?.r2_key.replace(/\.eml$/, "")}/attachments/1-more.txt`);
    expect(await (await env.MAIL_BUCKET.get(replyFile?.r2_key ?? ""))?.text()).toBe("reply file");
  });

  it("backfills attachments from a stored eml", async () => {
    const messageId = "<backfill-file@bots.example.test>";
    await deliver(
      [
        "From: ada@example.com",
        "To: glyph@bots.example.test",
        "Subject: Later",
        "Date: Thu, 09 Oct 2026 12:00:00 +0000",
        `Message-ID: ${messageId}`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="botmailbackfill"',
        "",
        "--botmailbackfill",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "stored already",
        "--botmailbackfill",
        'Content-Type: text/plain; name="later.txt"',
        'Content-Disposition: attachment; filename="later.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        btoa("from the eml"),
        "--botmailbackfill--",
        "",
      ].join("\r\n"),
      "ada@example.com",
      "glyph@bots.example.test",
    );
    const stored = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`).bind(messageId).first<{ id: string }>();
    await env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(stored?.id).run();
    await env.DB.prepare(`UPDATE messages SET has_attachments = 0, attachments_checked = 0 WHERE id = ?`).bind(stored?.id).run();

    const blocked = await worker.fetch(
      await adminRequest("/admin/api/attachments/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(blocked.status).toBe(400);

    const response = await worker.fetch(
      await adminRequest("/admin/api/attachments/backfill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bot-mail-action": "1" },
        body: JSON.stringify({ limit: 25 }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scanned: number; attachments: number };
    expect(body.scanned).toBeGreaterThan(0);
    expect(body.attachments).toBeGreaterThan(0);
    const file = await env.DB.prepare(`SELECT filename, r2_key FROM attachments WHERE message_id = ?`).bind(stored?.id).first<{ filename: string; r2_key: string }>();
    expect(file?.filename).toBe("later.txt");
    expect(file?.r2_key.endsWith("/attachments/1-later.txt")).toBe(true);
    expect(await (await env.MAIL_BUCKET.get(file?.r2_key ?? ""))?.text()).toBe("from the eml");
  });
});
