import { ensureAngle, fitHeaderValue, messageIdTokens, parseMailbox } from "./address";
import { encodeBase64, loadAttachmentFiles, saveAttachments, type AttachmentFile } from "./attachments";
import {
  getBot,
  getMessage,
  getMessageForBot,
  insertMessage,
  loadSendConfig,
  parseJsonArray,
  resolveThreadId,
  updateMessage,
  type BotRow,
  type MessageRow,
} from "./db";
import { enabledDomains } from "./domains";
import { loadInboundPolicy, releaseOutboundQuota, reserveAutoReplyQuota, reserveStampQuota } from "./inbound-security";
import { logError, logInfo } from "./log";
import { AUTO_SUBMITTED_HEADER, HOP_HEADER, internalStampHeader, newStampId, STAMP_HEADER } from "./mail-stamp";
import { decideSend, parseAllowlistText } from "./policy";
import { addressesForSender, resolveSendFrom } from "./routing";
import { safeKeyPart, snippetFrom, utcParts } from "./text";

export type ComposeInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: AttachmentFile[];
  /** Mailbox address, or an alias that delivers to this mailbox. Omit to use the mailbox address. */
  from?: string;
  /** Accepted for older callers. A bot send to a BotMail recipient counts either way. */
  automated?: boolean;
};

export type SendResult = {
  status: "sent" | "partial" | "pending_approval" | "rejected" | "failed" | "draft";
  message_id: string;
  thread_id: string | null;
  external?: string[];
  error?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeRecipients(values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (!EMAIL_PATTERN.test(trimmed)) throw new Error(`Invalid email address: ${trimmed}`);
    out.push(trimmed);
  }
  return out;
}

export function buildSendPayload(input: {
  fromEmail: string;
  fromName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: AttachmentFile[];
}): EmailMessageBuilder {
  const headers: Record<string, string> = {};
  if (input.inReplyTo) headers["In-Reply-To"] = ensureAngle(input.inReplyTo);
  if (input.references) {
    const fitted = fitHeaderValue(messageIdTokens(input.references));
    if (fitted) headers.References = fitted;
  }
  const payload: EmailMessageBuilder = {
    from: { name: input.fromName, email: input.fromEmail },
    to: input.to.length > 0 ? input.to : input.cc,
    subject: input.subject,
  };
  if (input.to.length > 0 && input.cc.length > 0) payload.cc = input.cc;
  if (input.bcc.length > 0) payload.bcc = input.bcc;
  if (input.text?.trim()) payload.text = input.text;
  if (input.html?.trim()) payload.html = input.html;
  if (!payload.text && !payload.html) payload.text = "(empty)";
  if (Object.keys(headers).length > 0) payload.headers = headers;
  if (input.attachments && input.attachments.length > 0) {
    payload.attachments = input.attachments.map((file) =>
      file.inline
        ? {
            disposition: "inline" as const,
            contentId: file.contentId || file.filename,
            filename: file.filename,
            type: file.contentType,
            content: file.bytes,
          }
        : {
            disposition: "attachment" as const,
            filename: file.filename,
            type: file.contentType,
            content: file.bytes,
          },
    );
  }
  return payload;
}

function stampedPayload(
  base: {
    fromEmail: string;
    fromName: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string | null;
    references?: string | null;
    attachments?: AttachmentFile[];
  },
  to: string[],
  cc: string[],
  bcc: string[],
  stamp: string | null,
  loop: { automated: boolean; hops: number } | null,
): EmailMessageBuilder {
  const lists = to.length > 0 ? { to, cc, bcc } : cc.length > 0 ? { to: cc, cc: [] as string[], bcc } : { to: bcc, cc: [] as string[], bcc: [] as string[] };
  const payload = buildSendPayload({ ...base, ...lists });
  const headers = { ...(payload.headers ?? {}) };
  if (stamp && loop?.automated) {
    headers[AUTO_SUBMITTED_HEADER] = "auto-generated";
    headers[HOP_HEADER] = String(loop.hops);
  }
  if (stamp) headers[STAMP_HEADER] = stamp;
  if (Object.keys(headers).length > 0) payload.headers = headers;
  return payload;
}

export function archiveEml(input: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  messageId: string;
  date: string;
  text: string;
  html: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: AttachmentFile[];
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    input.cc.length ? `Cc: ${input.cc.join(", ")}` : "",
    `Subject: ${input.subject}`,
    `Date: ${input.date}`,
    `Message-ID: ${ensureAngle(input.messageId)}`,
    input.inReplyTo ? `In-Reply-To: ${ensureAngle(input.inReplyTo)}` : "",
    input.references ? `References: ${input.references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  const body = mimeBody(input.text, input.html);
  const files = input.attachments ?? [];
  if (files.length === 0) return [...headers, body].join("\r\n");
  const boundary = `botmail_${crypto.randomUUID()}`;
  const parts = files.map((file) => {
    const name = file.filename.replaceAll('"', "");
    const disposition = file.inline ? "inline" : "attachment";
    const cid = file.contentId ? `Content-ID: ${ensureAngle(file.contentId)}\r\n` : "";
    return [
      `--${boundary}`,
      `Content-Type: ${file.contentType}; name="${name}"`,
      `Content-Disposition: ${disposition}; filename="${name}"`,
      `${cid}Content-Transfer-Encoding: base64`,
      "",
      encodeBase64(file.bytes),
      "",
    ].join("\r\n");
  });
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    body,
    ...parts,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function mimeBody(text: string, html: string): string {
  if (html && text) {
    const boundary = `botmail_alt_${crypto.randomUUID()}`;
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  if (html) return ["Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n");
  return ["Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n");
}

async function threadingFor(env: Env, botId: string, input: ComposeInput): Promise<{
  inReplyTo: string | null;
  references: string | null;
  threadId: string | null;
}> {
  const inReplyTo = input.inReplyTo ? ensureAngle(input.inReplyTo) : null;
  const tokens = [...messageIdTokens(input.references), ...(inReplyTo ? [inReplyTo] : [])];
  const references = tokens.length ? fitHeaderValue(tokens) : null;
  const threadId = await resolveThreadId(env, botId, tokens);
  return { inReplyTo, references, threadId };
}

export async function submitOutbound(
  env: Env,
  bot: BotRow,
  input: ComposeInput,
  actor: "bot" | "admin",
  existingId?: string,
): Promise<SendResult> {
  const from = await resolveSendFrom(env, bot, input.from);
  const internal = await enabledDomains(env);
  if (!internal.includes(from.slice(from.lastIndexOf("@") + 1))) {
    throw new Error(`${from} is on a disabled domain and cannot send. Enable the domain first.`);
  }
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc);
  const bcc = normalizeRecipients(input.bcc);
  const recipients = [...to, ...cc, ...bcc];
  if (recipients.length === 0) throw new Error("At least one recipient is required");
  if (recipients.length > 50) throw new Error("At most 50 recipients are allowed");
  if (!input.text?.trim() && !input.html?.trim()) throw new Error("A text or html body is required");

  const existing = existingId ? await getMessageForBot(env, bot.id, existingId) : null;
  if (existingId && !existing) throw new Error("Draft not found");
  if (existing && existing.folder !== "drafts" && existing.status !== "failed") {
    throw new Error("Message is not a draft");
  }
  if (actor === "bot" && existing && (existing.status === "pending_approval" || existing.status === "rejected")) {
    return {
      status: existing.status === "rejected" ? "rejected" : "pending_approval",
      message_id: existing.id,
      thread_id: existing.thread_id,
      error: existing.status === "rejected" ? "Draft was rejected" : "Draft is waiting for admin approval",
    };
  }

  const config = await loadSendConfig(env);
  const allowlistOnly = String(env.OUTBOUND_ALLOWLIST_ONLY || "") === "true";
  const decision = decideSend({
    recipients,
    mailDomain: internal,
    allowlist: allowlistOnly ? parseAllowlistText(String(env.SEND_ALLOWLIST || "")) : config.allowlist,
    policy: config.policy,
    allowlistOnly,
  });
  if (allowlistOnly && !decision.allowed) {
    throw new Error(
      `Outbound mail is limited to BotMail domains and the config allowlist. Refused: ${decision.external.join(", ")}`,
    );
  }
  const thread = await threadingFor(env, bot.id, input);
  const subject = input.subject.trim() || "(no subject)";
  const text = input.text ?? "";
  const html = input.html ?? "";
  const files = input.attachments ?? (existing ? await loadAttachmentFiles(env, existing.id, bot.id) : []);
  const reason = decision.allowed
    ? null
    : `External recipients require approval: ${decision.external.join(", ")}`;

  if (!decision.allowed && actor === "bot") {
    const row = await upsertDraft(env, bot, existing, {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      thread,
      status: "pending_approval",
      reason,
    });
    await saveAttachments(env, {
      messageId: row.id,
      botId: bot.id,
      emlKey: `${bot.id}/pending/${row.id}.eml`,
      files,
      replace: true,
    });
    logInfo("send_held", { bot: bot.id, message_id: row.id, external: decision.external.length });
    return {
      status: "pending_approval",
      message_id: row.id,
      thread_id: row.thread_id,
      external: decision.external,
    };
  }

  const domainSet = new Set(internal);
  const onDomain = (address: string) => {
    const domain = parseMailbox(address)?.domain;
    return domain ? domainSet.has(domain) : false;
  };
  const toInside = to.filter(onDomain);
  const toOutside = to.filter((address) => !onDomain(address));
  const ccInside = cc.filter(onDomain);
  const ccOutside = cc.filter((address) => !onDomain(address));
  const bccInside = bcc.filter(onDomain);
  const bccOutside = bcc.filter((address) => !onDomain(address));
  const insideRecipients = [...toInside, ...ccInside, ...bccInside];
  const policy = await loadInboundPolicy(env);
  const priorHop = actor === "admin" ? 0 : await priorAutomatedHop(env, bot.id, thread.inReplyTo);
  const automated = actor === "bot" && insideRecipients.length > 0;
  const hops = automated ? priorHop + 1 : 0;
  const basePayload = {
    fromEmail: from,
    fromName: bot.display_name,
    subject,
    text,
    html,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    attachments: files,
  };
  const loop = automated ? { automated: true, hops } : null;
  const quotaAttempt = crypto.randomUUID();
  let keepQuota = false;

  try {
    if (automated && insideRecipients.length > 0) {
      const reserved = await reserveAutoReplyQuota(
        env,
        bot.id,
        quotaAttempt,
        insideRecipients,
        policy.autoReplyLimit,
        policy.autoReplyWindow,
      );
      if (!reserved) {
        throw new Error(`Auto-reply loop: automated replies in the window hit the limit of ${policy.autoReplyLimit}`);
      }
    }
    if (insideRecipients.length > 0) {
      const reserved = await reserveStampQuota(env, bot.id, quotaAttempt, insideRecipients, policy.dailyStampLimit);
      if (!reserved) {
        throw new Error(`Daily stamp limit: stamped recipients in the last day hit the limit of ${policy.dailyStampLimit}`);
      }
    }
    let insideId = "";
    let outsideId = "";
    let outsideError = "";
    if (insideRecipients.length > 0) {
      const stamp = env.DATA_KEY
        ? await internalStampHeader(env.DATA_KEY, newStampId(from), from, insideRecipients, { subject, text, html })
        : null;
      if (!stamp) throw new Error("Could not stamp mail to a BotMail recipient");
      const sent = await env.EMAIL.send(stampedPayload(basePayload, toInside, ccInside, bccInside, stamp, loop));
      keepQuota = true;
      insideId = sent.messageId;
    }
    if (toOutside.length + ccOutside.length + bccOutside.length > 0) {
      try {
        const sent = await env.EMAIL.send(stampedPayload(basePayload, toOutside, ccOutside, bccOutside, null, null));
        outsideId = sent.messageId;
      } catch (error) {
        if (!insideId) throw error;
        outsideError = error instanceof Error ? error.message : "outside send failed";
        logError("email_send_failed", { bot: bot.id, error: outsideError });
      }
    }
    const headerId = ensureAngle(insideId || outsideId);
    const splitNote =
      insideId && outsideId
        ? `inside ${ensureAngle(insideId)}; outside ${ensureAngle(outsideId)}`
        : outsideError
          ? `inside ${ensureAngle(insideId)}; outside failed: ${outsideError}`
          : null;
    const threadId = thread.threadId ?? headerId;
    const date = new Date().toISOString();
    const raw = archiveEml({
      from,
      to,
      cc,
      subject,
      messageId: headerId,
      date,
      text,
      html,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      attachments: files,
    });
    const parts = utcParts(date);
    const key = `${bot.id}/${parts.yyyy}/${parts.mm}/${parts.dd}/${safeKeyPart(headerId)}.eml`;
    await env.MAIL_BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
    const row = await upsertDraft(env, bot, existing, {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      thread: { ...thread, threadId },
      status: outsideError ? "partial" : "sent",
      reason: splitNote,
      messageIdHeader: headerId,
      r2Key: key,
      rawSize: new TextEncoder().encode(raw).byteLength,
      folder: "sent",
      isRead: true,
      messageDate: date,
      hopCount: hops,
    });
    await saveAttachments(env, { messageId: row.id, botId: bot.id, emlKey: key, files, replace: true });
    logInfo(outsideError ? "email_sent_partial" : "email_sent", { bot: bot.id, message_id: row.id });
    return { status: outsideError ? "partial" : "sent", message_id: row.id, thread_id: row.thread_id };
  } catch (error) {
    if (!keepQuota) {
      try {
        await releaseOutboundQuota(env, bot.id, quotaAttempt);
      } catch (releaseError) {
        logError("quota_release_failed", {
          bot: bot.id,
          error: releaseError instanceof Error ? releaseError.message : "quota release failed",
        });
      }
    }
    const message = error instanceof Error ? error.message : "send failed";
    const row = await upsertDraft(env, bot, existing, {
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      thread,
      status: "failed",
      reason: message,
    });
    await saveAttachments(env, {
      messageId: row.id,
      botId: bot.id,
      emlKey: `${bot.id}/pending/${row.id}.eml`,
      files,
      replace: true,
    });
    logError("email_send_failed", { bot: bot.id, message_id: row.id, error: message });
    return { status: "failed", message_id: row.id, thread_id: row.thread_id, error: message };
  }
}

async function priorAutomatedHop(env: Env, botId: string, inReplyTo: string | null): Promise<number> {
  if (!inReplyTo) return 0;
  const row = await env.DB.prepare(
    `SELECT hop_count, auth_result, direction FROM messages WHERE bot_id = ? AND message_id_header = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(botId, ensureAngle(inReplyTo))
    .first<{ hop_count: number; auth_result: string | null; direction: string }>();
  if (!row?.hop_count) return 0;
  if (row.direction === "in" && row.auth_result !== "internal") return 0;
  return row.hop_count;
}

async function upsertDraft(
  env: Env,
  bot: BotRow,
  existing: MessageRow | null,
  fields: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
    html: string;
    thread: { inReplyTo: string | null; references: string | null; threadId: string | null };
    status: string;
    reason: string | null;
    messageIdHeader?: string | null;
    r2Key?: string | null;
    rawSize?: number | null;
    folder?: string;
    isRead?: boolean;
    messageDate?: string;
    hopCount?: number;
  },
): Promise<MessageRow> {
  const folder = fields.folder ?? "drafts";
  const common = {
    botId: bot.id,
    direction: "out" as const,
    folder,
    status: fields.status,
    fromAddr: fields.from,
    toAddrs: fields.to,
    ccAddrs: fields.cc,
    bccAddrs: fields.bcc,
    subject: fields.subject,
    messageDate: fields.messageDate ?? new Date().toISOString(),
    threadId: fields.thread.threadId,
    inReplyTo: fields.thread.inReplyTo,
    referencesHeader: fields.thread.references,
    snippet: snippetFrom(fields.text, fields.html),
    textBody: fields.text,
    htmlBody: fields.html || null,
    isRead: fields.isRead ?? true,
    approvalReason: fields.reason,
    hopCount: fields.hopCount,
    messageIdHeader: fields.messageIdHeader ?? existing?.message_id_header ?? null,
    r2Key: fields.r2Key ?? existing?.r2_key ?? null,
    rawSize: fields.rawSize ?? existing?.raw_size ?? null,
  };
  if (existing) {
    await updateMessage(env, existing.id, common);
    const updated = await getMessageForBot(env, bot.id, existing.id);
    if (!updated) throw new Error("Draft update failed");
    return updated;
  }
  return insertMessage(env, common);
}

export async function createDraft(env: Env, bot: BotRow, input: ComposeInput): Promise<SendResult> {
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc);
  const bcc = normalizeRecipients(input.bcc);
  if (to.length + cc.length + bcc.length === 0) throw new Error("At least one recipient is required");
  if (!input.text?.trim() && !input.html?.trim()) throw new Error("A text or html body is required");
  const thread = await threadingFor(env, bot.id, input);
  const row = await insertMessage(env, {
    botId: bot.id,
    direction: "out",
    folder: "drafts",
    status: "draft",
    fromAddr: await resolveSendFrom(env, bot, input.from),
    toAddrs: to,
    ccAddrs: cc,
    bccAddrs: bcc,
    subject: input.subject.trim() || "(no subject)",
    textBody: input.text ?? "",
    htmlBody: input.html ?? null,
    snippet: snippetFrom(input.text, input.html),
    threadId: thread.threadId,
    inReplyTo: thread.inReplyTo,
    referencesHeader: thread.references,
    isRead: true,
  });
  return { status: "draft", message_id: row.id, thread_id: row.thread_id };
}

export async function sendExistingDraft(
  env: Env,
  bot: BotRow,
  draftId: string,
  actor: "bot" | "admin",
  automated = false,
): Promise<SendResult> {
  const draft = await getMessageForBot(env, bot.id, draftId);
  if (!draft) throw new Error("Draft not found");
  return submitOutbound(env, bot, { ...(await composeFromRow(env, draft)), automated }, actor, draft.id);
}

export async function approveDraft(env: Env, draftId: string): Promise<SendResult> {
  const draft = await getMessage(env, draftId);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "pending_approval") throw new Error("Draft is not pending approval");
  const bot = await getBot(env, draft.bot_id);
  if (!bot) throw new Error("Bot not found");
  return submitOutbound(env, bot, await composeFromRow(env, draft), "admin", draft.id);
}

export async function rejectDraft(env: Env, draftId: string, reason?: string): Promise<SendResult> {
  const draft = await getMessage(env, draftId);
  if (!draft) throw new Error("Draft not found");
  if (draft.status !== "pending_approval") throw new Error("Draft is not pending approval");
  await updateMessage(env, draft.id, {
    status: "rejected",
    approvalReason: reason?.trim() || "Rejected by admin",
  });
  return { status: "rejected", message_id: draft.id, thread_id: draft.thread_id };
}

async function composeFromRow(env: Env, row: MessageRow): Promise<ComposeInput> {
  return {
    to: parseJsonArray(row.to_addrs),
    cc: parseJsonArray(row.cc_addrs),
    bcc: parseJsonArray(row.bcc_addrs),
    subject: row.subject ?? "",
    text: row.text_body ?? "",
    html: row.html_body ?? "",
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    attachments: await loadAttachmentFiles(env, row.id, row.bot_id),
    from: row.from_addr,
  };
}

export async function replyToMessage(
  env: Env,
  bot: BotRow,
  messageId: string,
  body: { text?: string; html?: string; attachments?: AttachmentFile[]; automated?: boolean; includeJunk?: boolean; from?: string },
): Promise<SendResult> {
  const original = await getMessageForBot(env, bot.id, messageId);
  if (!original || (original.folder === "junk" && body.includeJunk !== true)) throw new Error("Message not found");
  const senders = await addressesForSender(env, bot);
  const arrived = original.from_addr.toLowerCase();
  const to = senders.has(arrived) ? parseJsonArray(original.to_addrs) : [original.from_addr];
  const alias = original.via_alias && senders.has(original.via_alias.toLowerCase()) ? original.via_alias : undefined;
  const subject = original.subject?.toLowerCase().startsWith("re:")
    ? (original.subject ?? "")
    : `Re: ${original.subject ?? ""}`;
  const prior = [...messageIdTokens(original.references_header)];
  if (original.message_id_header) prior.push(ensureAngle(original.message_id_header));
  return submitOutbound(env, bot, {
    to,
    cc: [],
    subject,
    text: body.text,
    html: body.html,
    inReplyTo: original.message_id_header,
    references: prior.join(" "),
    attachments: body.attachments,
    automated: body.automated === true,
    from: body.from ?? alias,
  }, "bot");
}
