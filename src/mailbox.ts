import { listAttachments, MESSAGE_COLUMNS, parseJsonArray, type AttachmentRow, type MessageRow } from "./db";

export type MessageSummary = {
  id: string;
  bot: string;
  message_id_header: string | null;
  direction: string;
  folder: string;
  status: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  date: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  snippet: string | null;
  has_attachments: boolean;
  is_read: boolean;
  plus_tag: string | null;
  auth_result: string | null;
  auth_passed: boolean | null;
  quarantine_reason: string | null;
  spam_score: number | null;
  via_alias: string | null;
};

export function summarize(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    bot: row.bot_id,
    message_id_header: row.message_id_header,
    direction: row.direction,
    folder: row.folder,
    status: row.status,
    from: row.from_addr,
    to: parseJsonArray(row.to_addrs),
    cc: parseJsonArray(row.cc_addrs),
    bcc: parseJsonArray(row.bcc_addrs),
    subject: row.subject,
    date: row.message_date,
    thread_id: row.thread_id,
    in_reply_to: row.in_reply_to,
    snippet: row.snippet,
    has_attachments: row.has_attachments === 1,
    is_read: row.is_read === 1,
    plus_tag: row.plus_tag,
    auth_result: row.auth_result ?? null,
    auth_passed: row.auth_passed == null ? null : row.auth_passed === 1,
    quarantine_reason: row.quarantine_reason ?? null,
    spam_score: row.spam_score ?? null,
    via_alias: row.via_alias ?? null,
  };
}

export async function messageDetail(env: Env, row: MessageRow): Promise<Record<string, unknown>> {
  const attachments = await listAttachments(env, row.id, row.bot_id);
  return {
    ...summarize(row),
    references: row.references_header,
    text: row.text_body,
    html: row.html_body,
    body_truncated: row.body_truncated === 1,
    approval_reason: row.approval_reason,
    r2_key: row.r2_key,
    attachments: attachments.map(attachmentMeta),
  };
}

export function attachmentMeta(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    disposition: row.disposition,
    content_id: row.content_id,
    inline: row.inline === 1,
  };
}

export type ListFilter = {
  unread?: boolean;
  from?: string;
  since?: string;
  folder?: string;
  direction?: "in" | "out";
  status?: string;
  limit?: number;
};

export async function listMessages(env: Env, botId: string, filter: ListFilter): Promise<MessageRow[]> {
  const where = ["bot_id = ?"];
  const binds: Array<string | number> = [botId];
  if (filter.unread) {
    where.push("is_read = 0");
  }
  if (filter.from) {
    where.push("from_addr LIKE ? ESCAPE '\\'");
    binds.push(`%${escapeLike(filter.from)}%`);
  }
  if (filter.since) {
    where.push("message_date >= ?");
    binds.push(filter.since);
  }
  if (filter.folder) {
    where.push("folder = ?");
    binds.push(filter.folder);
  } else {
    where.push("folder != 'junk'");
  }
  if (filter.direction) {
    where.push("direction = ?");
    binds.push(filter.direction);
  }
  if (filter.status) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 100);
  const result = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages WHERE ${where.join(" AND ")}
     ORDER BY message_date DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<MessageRow>();
  return result.results;
}

/** A bot sees a junk row only when that call opts in. */
export function junkOmitted(folder: string, includeJunk: boolean): boolean {
  return folder === "junk" && !includeJunk;
}

export async function searchMessages(env: Env, botId: string, query: string, limit = 50, includeJunk = false): Promise<MessageRow[]> {
  const needle = `%${escapeLike(query)}%`;
  const capped = Math.min(Math.max(limit, 1), 100);
  const result = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages
     WHERE bot_id = ?
       AND (? = 1 OR folder != 'junk')
       AND (
         subject LIKE ? ESCAPE '\\'
         OR from_addr LIKE ? ESCAPE '\\'
         OR snippet LIKE ? ESCAPE '\\'
         OR text_body LIKE ? ESCAPE '\\'
       )
     ORDER BY message_date DESC
     LIMIT ?`,
  )
    .bind(botId, includeJunk ? 1 : 0, needle, needle, needle, needle, capped)
    .all<MessageRow>();
  return result.results;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
