import { EmailMessage } from "cloudflare:email";
import PostalMime, { addressParser, type Address } from "postal-mime";
import { ensureAngle, messageIdTokens, parseMailbox, textClaimsBotDomain } from "./address";
import { filesFromMime, saveAttachments } from "./attachments";
import {
  findDuplicateMessage,
  getBot,
  insertMessageClaimingStamp,
  listAttachments,
  resolveThreadId,
  updateMessage,
  type BotRow,
  type MessageRow,
} from "./db";
import { allDomains, configuredDomain, enabledDomains, ensureDomains } from "./domains";
import { decideInbound } from "./inbound-security";
import { contentDigest, matchingStampId, stampHeaderCount, stampHeaderFromRaw, stripForwardHeaders, stripStampHeader } from "./mail-stamp";
import { logError, logInfo } from "./log";
import { resolveRecipient, type InboundTarget } from "./routing";
import { UNROUTED_BOT_ID, UNROUTED_FOLDER } from "./seed-bots";
import { capBody, safeKeyPart, snippetFrom, utcParts } from "./text";
import { notifyBot } from "./webhook";

const MAX_RAW_BYTES = 25 * 1024 * 1024;

export type InboundEmail = {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward?(rcpt: string): Promise<void>;
};

export type InboundDeps = {
  fetch?: typeof fetch;
};

function flattenAddresses(values: Address[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (value.group) {
      for (const member of value.group) {
        if (member.address) out.push(member.address);
      }
      continue;
    }
    if (value.address) out.push(value.address);
  }
  return out;
}

function headerParties(
  headers: Array<{ key: string; value: string }>,
  name: string,
  domains: string[],
): { addresses: string[]; unparsed: boolean } {
  const values = headers.filter((header) => header.key === name);
  if (values.length === 0) return { addresses: [], unparsed: false };
  const addresses: string[] = [];
  let unparsed = false;
  for (const header of values) {
    let parsed: Address[] = [];
    try {
      parsed = addressParser(header.value);
    } catch {
      if (textClaimsBotDomain(header.value, domains)) unparsed = true;
      continue;
    }
    const extracted = flattenAddresses(parsed);
    if (extracted.length === 0) {
      if (textClaimsBotDomain(header.value, domains)) unparsed = true;
      continue;
    }
    for (const address of extracted) {
      const mailbox = parseMailbox(address);
      if (mailbox) addresses.push(mailbox.address);
      else if (textClaimsBotDomain(address, domains)) unparsed = true;
    }
  }
  return { addresses, unparsed };
}

export async function processInboundEmail(message: InboundEmail, env: Env, deps: InboundDeps = {}): Promise<void> {
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject("Message too large");
    logInfo("email_rejected", { reason: "too_large", bytes: message.rawSize });
    return;
  }

  const rawIn = await new Response(message.raw).arrayBuffer();
  const raw = stripStampHeader(rawIn);
  const parsed = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  if (!configuredDomain(env)) {
    logError("email_rejected", { reason: "mail_domain_missing" });
    message.setReject("Mailbox is not configured");
    return;
  }
  await ensureDomains(env);

  const envelope = parseMailbox(message.to);
  const domains = await enabledDomains(env);
  const claimDomains = await allDomains(env);
  if (!envelope || !domains.includes(envelope.domain)) {
    message.setReject("Recipient domain is not a BotMail domain");
    logInfo("email_rejected", { reason: "wrong_domain", domain: envelope?.domain ?? null });
    return;
  }
  const fromParties = headerParties(parsed.headers, "from", claimDomains);
  const senderParties = headerParties(parsed.headers, "sender", claimDomains);
  const from = fromParties.addresses[0] || parseMailbox(message.from)?.address || message.from;
  const toAddrs = flattenAddresses(parsed.to);
  const ccAddrs = flattenAddresses(parsed.cc);
  const storedTo = toAddrs.length > 0 ? toAddrs : [message.to];
  const messageDate = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();
  const validDate = Number.isNaN(new Date(messageDate).getTime()) ? new Date().toISOString() : messageDate;
  const headerId = parsed.messageId ? ensureAngle(parsed.messageId) : null;
  const textBody = parsed.text ?? "";
  const htmlBody = typeof parsed.html === "string" ? parsed.html : "";
  const textCap = capBody(textBody);
  const htmlCap = capBody(htmlBody);
  const snippet = snippetFrom(textCap.text, htmlCap.text);
  const subject = parsed.subject ?? message.headers.get("subject") ?? "";
  const inReplyTo = parsed.inReplyTo ? ensureAngle(parsed.inReplyTo) : null;
  const referenceTokens = [...messageIdTokens(parsed.references), ...(inReplyTo ? [inReplyTo] : [])];

  const decision = await resolveRecipient(env, envelope.local, envelope.domain);
  if (decision.action === "reject") {
    message.setReject(decision.reason);
    logInfo("email_rejected", { reason: "unknown_recipient", local: envelope.local, domain: envelope.domain });
    return;
  }
  const files = filesFromMime(parsed.attachments);
  const plans: InboundTarget[] =
    decision.action === "deliver"
      ? decision.targets
      : [{ bot: (await getBot(env, UNROUTED_BOT_ID)) as BotRow, viaAlias: null, forwardTo: null }];
  if (!plans[0]?.bot) {
    message.setReject("Unrouted mailbox is not provisioned");
    return;
  }
  const unroutedAddress = `${envelope.local}${envelope.plus ? `+${envelope.plus}` : ""}@${envelope.domain}`;

  for (const plan of plans) {
    const unrouted = decision.action !== "deliver";
    const stored = await storeInbound(env, message, {
      bot: plan.bot,
      unrouted,
      viaAlias: plan.viaAlias,
      plusTag: unrouted ? unroutedAddress : (envelope.plus ?? null),
      raw,
      rawIn,
      from,
      storedTo,
      ccAddrs,
      subject,
      textBody,
      htmlBody,
      textCap,
      htmlCap,
      snippet,
      validDate,
      headerId,
      inReplyTo,
      referenceTokens,
      files,
      claimDomains,
      fromAddresses: fromParties.addresses,
      senderAddresses: senderParties.addresses,
      unparsedSender: fromParties.unparsed || senderParties.unparsed,
    });
    if (!stored) continue;
    if (!stored.quarantined && !stored.junked && decision.action === "forward") {
      await forwardExternal(env, message, stored.row, decision.rcpt, from, envelope.local, raw, rawIn, stored.stampId);
    }
    if (!stored.quarantined && !stored.junked && !unrouted) await notifyBot(env, plan.bot, stored.row, deps.fetch);
    if (!stored.quarantined && !stored.junked && stored.row.folder === "inbox" && plan.forwardTo) {
      const copy = await storeInbound(env, message, {
        bot: plan.forwardTo,
        unrouted: false,
        viaAlias: plan.viaAlias,
        plusTag: envelope.plus ?? null,
        raw,
        rawIn,
        from,
        storedTo,
        ccAddrs,
        subject,
        textBody,
        htmlBody,
        textCap,
        htmlCap,
        snippet,
        validDate,
        headerId,
        inReplyTo,
        referenceTokens,
        files,
        claimDomains,
        fromAddresses: fromParties.addresses,
        senderAddresses: senderParties.addresses,
        unparsedSender: fromParties.unparsed || senderParties.unparsed,
        security: stored.security,
      });
      if (copy && !copy.quarantined && !copy.junked) await notifyBot(env, plan.forwardTo, copy.row, deps.fetch);
    }
  }
}

type InboundSecurity = {
  authResult: string;
  authPassed: boolean | null;
  quarantineReason: string | null;
  stampId: string | null;
  hopCount: number;
  spamScore: number | null;
  junk: boolean;
};

async function storeInbound(
  env: Env,
  message: InboundEmail,
  input: {
    bot: BotRow;
    unrouted: boolean;
    viaAlias: string | null;
    plusTag: string | null;
    raw: ArrayBuffer;
    rawIn: ArrayBuffer;
    from: string;
    storedTo: string[];
    ccAddrs: string[];
    subject: string;
    textBody: string;
    htmlBody: string;
    textCap: { text: string | null; truncated: boolean };
    htmlCap: { text: string | null; truncated: boolean };
    snippet: string;
    validDate: string;
    headerId: string | null;
    inReplyTo: string | null;
    referenceTokens: string[];
    files: ReturnType<typeof filesFromMime>;
    claimDomains: string[];
    fromAddresses: string[];
    senderAddresses: string[];
    unparsedSender: boolean;
    security?: InboundSecurity;
  },
): Promise<{ row: MessageRow; quarantined: boolean; junked: boolean; stampId: string | null; security: InboundSecurity } | null> {
  const security =
    input.security ??
    (await decideInbound(env, {
      raw: input.rawIn,
      from: input.from,
      envelopeFrom: message.from,
      to: message.to,
      botId: input.bot.id,
      subject: input.subject,
      text: input.textBody,
      html: input.htmlBody,
      domains: input.claimDomains,
      fromAddresses: input.fromAddresses,
      senderAddresses: input.senderAddresses,
      unparsedSender: input.unparsedSender,
    }));
  const quarantined = security.quarantineReason != null;
  const junked = !quarantined && !input.unrouted && security.junk;
  const folder = quarantined ? "quarantine" : junked ? "junk" : input.unrouted ? UNROUTED_FOLDER : "inbox";
  if (input.headerId) {
    const duplicate = await findDuplicateMessage(env, input.bot.id, input.headerId, "in");
    if (duplicate) {
      await ensureStoredRaw(env, duplicate, input.raw, input.rawIn, { subject: input.subject, text: input.textBody, html: input.htmlBody }, input.files, message.to);
      logInfo("email_duplicate", { bot: input.bot.id, message_id: duplicate.id });
      return null;
    }
  }
  const threadId = (await resolveThreadId(env, input.bot.id, input.referenceTokens)) ?? input.headerId ?? crypto.randomUUID();
  const id = crypto.randomUUID();
  const parts = utcParts(input.validDate);
  const fileId = safeKeyPart(input.headerId ?? id);
  const emlKey = `${input.bot.id}/${parts.yyyy}/${parts.mm}/${parts.dd}/${fileId}.eml`;
  let row: MessageRow;
  try {
    const stored = await insertMessageClaimingStamp(
      env,
      {
        id,
        botId: input.bot.id,
        messageIdHeader: input.headerId,
        direction: "in",
        folder,
        status: quarantined ? "quarantined" : "received",
        fromAddr: input.from,
        toAddrs: input.storedTo,
        ccAddrs: input.ccAddrs,
        subject: input.subject,
        messageDate: input.validDate,
        threadId,
        inReplyTo: input.inReplyTo,
        referencesHeader: input.referenceTokens.length ? input.referenceTokens.join(" ") : null,
        snippet: input.snippet,
        textBody: input.textCap.text,
        htmlBody: input.htmlCap.text,
        bodyTruncated: input.textCap.truncated || input.htmlCap.truncated,
        hasAttachments: input.files.length > 0,
        isRead: false,
        plusTag: input.plusTag,
        viaAlias: input.viaAlias,
        r2Key: emlKey,
        rawSize: input.raw.byteLength,
        authResult: security.authResult,
        authPassed: security.authPassed,
        quarantineReason: security.quarantineReason,
        hopCount: security.hopCount,
        spamScore: security.spamScore,
      },
      security.stampId ? { stampId: security.stampId, botId: input.bot.id } : null,
    );
    if (stored === "duplicate") {
      logInfo("email_duplicate", { bot: input.bot.id, reason: "stamp" });
      return null;
    }
    row = stored;
  } catch (error) {
    if (input.headerId) {
      const duplicate = await findDuplicateMessage(env, input.bot.id, input.headerId, "in");
      if (duplicate) return null;
    }
    logError("email_store_failed", { error: error instanceof Error ? error.message : "insert failed" });
    throw error;
  }
  await env.MAIL_BUCKET.put(emlKey, input.raw, { httpMetadata: { contentType: "message/rfc822" } });
  await saveAttachments(env, { messageId: row.id, botId: input.bot.id, emlKey, files: input.files });
  logInfo(quarantined ? "email_quarantined" : junked ? "email_junked" : "email_stored", {
    bot: input.bot.id,
    message_id: row.id,
    folder,
    reason: security.quarantineReason,
    spam_score: security.spamScore,
    has_attachments: input.files.length > 0,
    bytes: input.raw.byteLength,
    via_alias: input.viaAlias,
  });
  return { row, quarantined, junked, stampId: security.stampId, security };
}

async function forwardExternal(
  env: Env,
  message: InboundEmail,
  row: MessageRow,
  rcpt: string,
  from: string,
  local: string,
  raw: ArrayBuffer,
  rawIn: ArrayBuffer,
  stampId: string | null,
): Promise<void> {
  let forwarded = false;
  try {
    if (stampId) {
      await env.EMAIL.send(new EmailMessage(from, rcpt, new Blob([stripForwardHeaders(raw)]).stream()));
      forwarded = true;
    } else if (stampHeaderCount(rawIn) > 0) {
      logInfo("email_forward_withheld", { local, message_id: row.id, reason: "stamp" });
    } else if (message.forward) {
      await message.forward(rcpt);
      forwarded = true;
    } else {
      logError("email_forward_unavailable", { local, message_id: row.id });
    }
  } catch (error) {
    logError("email_forward_unavailable", {
      local,
      message_id: row.id,
      error: error instanceof Error ? error.message : "forward failed",
    });
  }
  if (forwarded) {
    await updateMessage(env, row.id, { folder: "forwarded" });
    logInfo("email_forwarded", { local, message_id: row.id });
  }
}

async function ensureStoredRaw(
  env: Env,
  row: MessageRow,
  raw: ArrayBuffer,
  rawIn: ArrayBuffer,
  content: { subject: string; text: string; html: string },
  files: Array<{ bytes: Uint8Array }>,
  to: string,
): Promise<void> {
  if (!row.r2_key) return;
  const existing = await env.MAIL_BUCKET.head(row.r2_key);
  if (existing) return;
  const storedFiles = await storedAttachmentBytes(env, row);
  if (!storedFiles) {
    logInfo("email_duplicate_skipped", { bot: row.bot_id, message_id: row.id, reason: "attachments" });
    return;
  }
  const incoming = await fillDigest(content.subject, capBody(content.text).text ?? "", capBody(content.html).text ?? "", files);
  const stored = await fillDigest(row.subject ?? "", row.text_body ?? "", row.html_body ?? "", storedFiles);
  if (incoming !== stored) {
    logInfo("email_duplicate_skipped", { bot: row.bot_id, message_id: row.id, reason: "content" });
    return;
  }
  if (row.auth_result === "internal") {
    const stampId = await matchingStampId(env.DATA_KEY, stampHeaderFromRaw(rawIn), row.from_addr, to, content);
    if (!stampId) {
      logInfo("email_duplicate_skipped", { bot: row.bot_id, message_id: row.id, reason: "stamp" });
      return;
    }
  }
  await env.MAIL_BUCKET.put(row.r2_key, raw, { httpMetadata: { contentType: "message/rfc822" } });
}

async function fillDigest(subject: string, text: string, html: string, files: Array<{ bytes: Uint8Array }>): Promise<string> {
  const parts: string[] = [await contentDigest(subject, text, html)];
  const attachments: string[] = [];
  for (const file of files) attachments.push(`${file.bytes.byteLength}:${await sha256HexBytes(file.bytes)}`);
  attachments.sort();
  parts.push(attachments.join("\n"));
  return parts.join("\n");
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function storedAttachmentBytes(env: Env, row: MessageRow): Promise<Array<{ bytes: Uint8Array }> | null> {
  const listed = await listAttachments(env, row.id, row.bot_id);
  const files: Array<{ bytes: Uint8Array }> = [];
  for (const item of listed) {
    if (!item.r2_key) return null;
    const object = await env.MAIL_BUCKET.get(item.r2_key);
    if (!object) return null;
    files.push({ bytes: new Uint8Array(await object.arrayBuffer()) });
  }
  return files;
}
