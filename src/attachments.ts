import PostalMime from "postal-mime";
import { hmacEqual, hmacHex } from "./crypto";
import { insertAttachment, listAttachments, nowIso, getAttachmentForBot, type AttachmentRow } from "./db";
import { safeKeyPart } from "./text";

export const BASE64_ATTACHMENT_CAP = 256 * 1024;
const URL_TTL_SECONDS = 10 * 60;
const MAX_ATTACHMENTS = 20;

export type AttachmentFile = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  inline: boolean;
  contentId: string | null;
};

type MimeAttachment = {
  filename?: string | null;
  mimeType?: string | null;
  disposition?: string | null;
  contentId?: string | null;
  content?: ArrayBuffer | Uint8Array | string | null;
};

const ATTACHMENT_COLUMNS = `id, message_id, bot_id, filename, content_type, size_bytes, r2_key, content_id, disposition, inline`;

export function attachmentTooLarge(filename: string, size: number): Error {
  return new Error(`Attachment "${filename}" is ${size} bytes, over the ${BASE64_ATTACHMENT_CAP} byte cap`);
}

export function attachmentObjectKey(emlKey: string, index: number, filename: string): string {
  const prefix = emlKey.replace(/\.eml$/i, "");
  const name = safeKeyPart(filename || `attachment-${index + 1}`);
  return `${prefix}/attachments/${index + 1}-${name}`;
}

export function isTextContentType(contentType: string | null | undefined): boolean {
  const type = (contentType || "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/");
}

export function previewableImage(contentType: string | null | undefined): boolean {
  const type = (contentType || "").split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp";
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const cleaned = value.replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(cleaned);
  } catch {
    throw new Error("Attachment content_base64 is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function filesFromMime(attachments: MimeAttachment[] | undefined): AttachmentFile[] {
  const files: AttachmentFile[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    if (attachment.content == null) continue;
    const bytes = bytesOf(attachment.content);
    if (bytes.byteLength === 0) continue;
    const inline = (attachment.disposition || "").toLowerCase() === "inline";
    files.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.mimeType || "application/octet-stream",
      bytes,
      inline,
      contentId: attachment.contentId ?? null,
    });
  }
  return files;
}

export function filesFromInput(
  inputs: Array<{ filename: string; content_type?: string; content_base64: string; inline?: boolean; content_id?: string }>,
): AttachmentFile[] {
  if (inputs.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments are allowed`);
  return inputs.map((input) => {
    const filename = input.filename.trim() || "attachment";
    const bytes = decodeBase64(input.content_base64);
    if (bytes.byteLength === 0) throw new Error(`Attachment "${filename}" is empty`);
    if (bytes.byteLength > BASE64_ATTACHMENT_CAP) throw attachmentTooLarge(filename, bytes.byteLength);
    return {
      filename,
      contentType: input.content_type?.trim() || "application/octet-stream",
      bytes,
      inline: Boolean(input.inline),
      contentId: input.content_id?.trim() || null,
    };
  });
}

export async function saveAttachments(
  env: Env,
  input: { messageId: string; botId: string; emlKey: string; files: AttachmentFile[]; replace?: boolean },
): Promise<void> {
  if (input.replace) {
    const existing = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id = ?`).bind(input.messageId).all<{ r2_key: string }>();
    for (const row of existing.results) await env.MAIL_BUCKET.delete(row.r2_key);
    await env.DB.prepare(`DELETE FROM attachments WHERE message_id = ?`).bind(input.messageId).run();
  }
  for (const [index, file] of input.files.entries()) {
    const key = attachmentObjectKey(input.emlKey, index, file.filename);
    await env.MAIL_BUCKET.put(key, file.bytes, { httpMetadata: { contentType: file.contentType } });
    await insertAttachment(env, {
      id: crypto.randomUUID(),
      message_id: input.messageId,
      bot_id: input.botId,
      filename: file.filename,
      content_type: file.contentType,
      size_bytes: file.bytes.byteLength,
      r2_key: key,
      content_id: file.contentId,
      disposition: file.inline ? "inline" : "attachment",
      inline: file.inline ? 1 : 0,
    });
  }
  await env.DB.prepare(`UPDATE messages SET has_attachments = ?, attachments_checked = 1, updated_at = ? WHERE id = ?`)
    .bind(input.files.length > 0 ? 1 : 0, nowIso(), input.messageId)
    .run();
}

export async function loadAttachmentFiles(env: Env, messageId: string, botId: string): Promise<AttachmentFile[]> {
  const rows = await listAttachments(env, messageId, botId);
  const files: AttachmentFile[] = [];
  for (const row of rows) {
    const object = await env.MAIL_BUCKET.get(row.r2_key);
    if (!object) continue;
    files.push({
      filename: row.filename || "attachment",
      contentType: row.content_type || "application/octet-stream",
      bytes: new Uint8Array(await object.arrayBuffer()),
      inline: row.inline === 1 || row.disposition === "inline",
      contentId: row.content_id,
    });
  }
  return files;
}

export async function backfillAttachments(env: Env, limit = 25): Promise<{ scanned: number; extracted: number; attachments: number }> {
  const pending = await env.DB.prepare(
    `SELECT id, bot_id, r2_key FROM messages
     WHERE r2_key IS NOT NULL AND IFNULL(attachments_checked, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id)
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit, 1), 100))
    .all<{ id: string; bot_id: string; r2_key: string }>();
  let extracted = 0;
  let attachments = 0;
  for (const row of pending.results) {
    const object = await env.MAIL_BUCKET.get(row.r2_key);
    const files = object ? filesFromMime((await PostalMime.parse(await object.arrayBuffer(), { attachmentEncoding: "arraybuffer" })).attachments) : [];
    await saveAttachments(env, { messageId: row.id, botId: row.bot_id, emlKey: row.r2_key, files });
    if (files.length > 0) extracted += 1;
    attachments += files.length;
  }
  return { scanned: pending.results.length, extracted, attachments };
}

export async function signAttachment(env: Env, attachmentId: string, origin: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  const sig = await hmacHex(env.DATA_KEY, `${attachmentId}.${exp}`);
  const url = new URL(`/attachments/${attachmentId}`, origin);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);
  return url.toString();
}

export async function readSignedAttachment(request: Request, env: Env, attachmentId: string): Promise<AttachmentRow | null> {
  const url = new URL(request.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) || !sig) return null;
  const ok = await hmacEqual(env.DATA_KEY, `${attachmentId}.${exp}`, sig);
  if (!ok) return null;
  return env.DB.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`).bind(attachmentId).first<AttachmentRow>();
}

export async function attachmentPayload(env: Env, botId: string, attachmentId: string): Promise<Record<string, unknown>> {
  const row = await getAttachmentForBot(env, botId, attachmentId);
  if (!row) throw new Error("Attachment not found");
  const filename = row.filename || "attachment";
  if (row.size_bytes > BASE64_ATTACHMENT_CAP) throw attachmentTooLarge(filename, row.size_bytes);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) throw new Error("Attachment object missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = row.content_type || "application/octet-stream";
  const payload: Record<string, unknown> = {
    id: row.id,
    message_id: row.message_id,
    filename: row.filename,
    content_type: contentType,
    size_bytes: row.size_bytes,
    content_id: row.content_id,
    inline: row.inline === 1,
  };
  if (isTextContentType(contentType)) payload.text = new TextDecoder().decode(bytes);
  else payload.base64 = encodeBase64(bytes);
  return payload;
}
