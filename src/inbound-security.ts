import { domainMatches, parseMailbox, type Mailbox } from "./address";
import { getBot, getMessage, getSetting, nowIso, putSetting, type MessageRow } from "./db";
import { allDomains } from "./domains";
import { HttpError } from "./errors";
import { cloudflareMailAuth, cloudflareTraceBlock } from "./mail-auth";
import { headerFields, hopCount, matchingStampId, stampHeaderFromRaw, type HeaderField } from "./mail-stamp";
import { normalizeAllowlist, parseAllowlistText } from "./policy";
import { notifyBot } from "./webhook";

export function normalizeRateLimit(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) return null;
  return parsed;
}

export function normalizeDailyStampLimit(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10000) return null;
  return parsed;
}

export function normalizeWindow(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 604800) return null;
  return parsed;
}

/** Integer 1-5, "off", or null when the value is missing or not one of those. */
export function normalizeSpamThreshold(value: string | number | null | undefined): number | "off" | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && value.trim().toLowerCase() === "off") return "off";
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) return null;
  return parsed;
}

/** The X-Cf-Spamh-Score that ends the Cloudflare trace block, when it is an integer from 0 to 5. Copies below the block are ignored. */
export function spamScoreFromFields(fields: HeaderField[]): number | null {
  const header = cloudflareTraceBlock(fields)?.find((field) => field.name.toLowerCase() === "x-cf-spamh-score");
  if (!header) return null;
  const token = header.value.trim().split(/\s+/, 1)[0] ?? "";
  if (!/^\d+$/.test(token)) return null;
  const score = Number(token);
  if (score > 5) return null;
  return score;
}

export type InboundPolicy = {
  rateLimit: number;
  botRateLimit: number;
  autoReplyLimit: number;
  autoReplyWindow: number;
  dailyStampLimit: number;
  spamThreshold: number | "off";
  source: "config" | "dashboard";
  allowlist: string[];
  blocklist: string[];
};

export async function loadInboundPolicy(env: Env): Promise<InboundPolicy> {
  const source = (await getSetting(env, "inbound_policy_source")) === "dashboard" ? "dashboard" : "config";
  const storedRate = normalizeRateLimit(await getSetting(env, "inbound_rate_limit"));
  const storedBotRate = normalizeRateLimit(await getSetting(env, "inbound_bot_rate_limit"));
  const storedAutoReply = normalizeRateLimit(await getSetting(env, "inbound_auto_reply_limit"));
  const storedWindow = normalizeWindow(await getSetting(env, "inbound_auto_reply_window"));
  const storedDaily = normalizeDailyStampLimit(await getSetting(env, "outbound_daily_stamp_limit"));
  const storedSpam = normalizeSpamThreshold(await getSetting(env, "spam_score_threshold"));
  const envRate = normalizeRateLimit(env.INBOUND_RATE_LIMIT);
  const envBotRate = normalizeRateLimit(env.INBOUND_BOT_RATE_LIMIT);
  const envAutoReply = normalizeRateLimit(env.INBOUND_AUTO_REPLY_LIMIT);
  const envWindow = normalizeWindow(env.INBOUND_AUTO_REPLY_WINDOW);
  const envDaily = normalizeDailyStampLimit(env.OUTBOUND_DAILY_STAMP_LIMIT);
  const envSpam = normalizeSpamThreshold(env.SPAM_SCORE_THRESHOLD);
  const spamThreshold = source === "dashboard" && storedSpam != null ? storedSpam : (envSpam ?? storedSpam ?? 4);
  return {
    rateLimit: source === "dashboard" && storedRate ? storedRate : (envRate ?? storedRate ?? 20),
    botRateLimit: source === "dashboard" && storedBotRate ? storedBotRate : (envBotRate ?? storedBotRate ?? 30),
    autoReplyLimit: source === "dashboard" && storedAutoReply ? storedAutoReply : (envAutoReply ?? storedAutoReply ?? 20),
    autoReplyWindow: source === "dashboard" && storedWindow ? storedWindow : (envWindow ?? storedWindow ?? 3600),
    dailyStampLimit: source === "dashboard" && storedDaily ? storedDaily : (envDaily ?? storedDaily ?? 200),
    spamThreshold,
    source,
    allowlist: parseAllowlistText(await getSetting(env, "inbound_allowlist")),
    blocklist: parseAllowlistText(await getSetting(env, "inbound_blocklist")),
  };
}

export async function saveInboundPolicy(
  env: Env,
  input: {
    rateLimit?: number;
    botRateLimit?: number;
    autoReplyLimit?: number;
    autoReplyWindow?: number;
    dailyStampLimit?: number;
    spamThreshold?: number | "off";
    source?: "config" | "dashboard";
  },
): Promise<InboundPolicy> {
  if (input.source === "config") {
    await putSetting(env, "inbound_policy_source", "config");
    return loadInboundPolicy(env);
  }
  if (input.rateLimit) await putSetting(env, "inbound_rate_limit", String(input.rateLimit));
  if (input.botRateLimit) await putSetting(env, "inbound_bot_rate_limit", String(input.botRateLimit));
  if (input.autoReplyLimit) await putSetting(env, "inbound_auto_reply_limit", String(input.autoReplyLimit));
  if (input.autoReplyWindow) await putSetting(env, "inbound_auto_reply_window", String(input.autoReplyWindow));
  if (input.dailyStampLimit) await putSetting(env, "outbound_daily_stamp_limit", String(input.dailyStampLimit));
  if (input.spamThreshold === "off" || typeof input.spamThreshold === "number") {
    await putSetting(env, "spam_score_threshold", input.spamThreshold === "off" ? "off" : String(input.spamThreshold));
  }
  if (
    input.rateLimit ||
    input.botRateLimit ||
    input.autoReplyLimit ||
    input.autoReplyWindow ||
    input.dailyStampLimit ||
    input.spamThreshold === "off" ||
    typeof input.spamThreshold === "number"
  ) {
    await putSetting(env, "inbound_policy_source", "dashboard");
  }
  return loadInboundPolicy(env);
}

export async function saveInboundList(env: Env, kind: "allow" | "block", entries: string[]): Promise<string[]> {
  const key = kind === "allow" ? "inbound_allowlist" : "inbound_blocklist";
  const normalized = normalizeAllowlist(entries);
  if (kind === "allow") {
    const domains = await allDomains(env);
    const refused = normalized.filter((entry) => domainClaimsBotMail(entryDomain(entry), domains));
    if (refused.length > 0) {
      throw new HttpError(`BotMail domains cannot be allowlisted: ${refused.join(", ")}`, 400, "inbound_allowlist");
    }
  }
  await putSetting(env, key, JSON.stringify(normalized));
  return normalized;
}

export type InboundDecision = {
  authResult: string;
  authPassed: boolean | null;
  quarantineReason: string | null;
  stampId: string | null;
  hopCount: number;
  spamScore: number | null;
  junk: boolean;
};

export async function decideInbound(
  env: Env,
  input: {
    raw: ArrayBuffer;
    from: string;
    envelopeFrom: string;
    to: string;
    botId: string;
    subject: string;
    text: string;
    html: string;
    domains: string[];
    fromAddresses: string[];
    senderAddresses: string[];
    unparsedSender: boolean;
  },
): Promise<InboundDecision> {
  const policy = await loadInboundPolicy(env);
  const stampId = await matchingStampId(env.DATA_KEY, stampHeaderFromRaw(input.raw), input.from, input.to, {
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  const claimsInternal = claimsBotDomain(input.fromAddresses, input.senderAddresses, input.envelopeFrom, input.domains);
  const mailbox = parseMailbox(input.from);
  const allowed = mailbox ? allowlisted(mailbox, policy.allowlist, input.domains) : false;
  const blocked = mailbox ? listed(mailbox, policy.blocklist) : false;
  const fields = headerFields(input.raw);
  const hop = stampId ? hopCount(fields) : 0;
  const singleFrom = input.fromAddresses.length === 1;
  const mailAuth = stampId
    ? { result: "internal", passed: true as boolean | null }
    : singleFrom
      ? cloudflareMailAuth(fields, mailbox?.domain ?? "")
      : { result: "unverified", passed: null as boolean | null };
  const authResult = mailAuth.result;
  const authPassed = mailAuth.passed;

  let quarantineReason: string | null = null;
  if (input.unparsedSender) quarantineReason = "unparsed sender";
  else if (claimsInternal && !stampId) quarantineReason = "unstamped internal sender";
  else if (blocked) quarantineReason = "blocked";
  else if (input.fromAddresses.length > 1) quarantineReason = "multiple from";
  else if (stampId && hop > 0 && (await recentAutomatedInbound(env, input.botId, input.from, policy.autoReplyWindow)) >= policy.autoReplyLimit) {
    quarantineReason = "auto reply loop";
  } else if (stampId && (await recentStampedFromSender(env, input.botId, input.from)) >= policy.botRateLimit) quarantineReason = "rate limited";
  else if (!stampId && !allowed && (await recentFromSender(env, input.botId, input.from)) >= policy.rateLimit) quarantineReason = "rate limited";

  const spamScore = spamScoreFromFields(fields);
  const junk = !stampId && typeof policy.spamThreshold === "number" && spamScore != null && spamScore >= policy.spamThreshold;
  return { authResult, authPassed, quarantineReason, stampId, hopCount: hop, spamScore, junk };
}

export async function releaseQuarantine(env: Env, id: string): Promise<MessageRow> {
  const row = await getMessage(env, id);
  if (!row) throw new Error("Message not found");
  if (row.folder !== "quarantine") throw new Error("Message is not quarantined");
  const updated = await env.DB.prepare(
    `UPDATE messages SET folder = 'inbox', status = 'received', quarantine_reason = NULL, is_read = 0, updated_at = ? WHERE id = ? AND folder = 'quarantine'`,
  )
    .bind(nowIso(), id)
    .run();
  if (Number(updated.meta.changes ?? 0) !== 1) throw new Error("Message is not quarantined");
  const next = await getMessage(env, id);
  if (!next) throw new Error("Message not found");
  const bot = await getBot(env, next.bot_id);
  if (bot && bot.id !== "_unrouted") await notifyBot(env, bot, next);
  return next;
}

export async function releaseJunk(env: Env, id: string): Promise<MessageRow> {
  const row = await getMessage(env, id);
  if (!row) throw new Error("Message not found");
  if (row.folder !== "junk") throw new Error("Message is not in junk");
  const updated = await env.DB.prepare(
    `UPDATE messages SET folder = 'inbox', status = 'received', is_read = 0, updated_at = ? WHERE id = ? AND folder = 'junk'`,
  )
    .bind(nowIso(), id)
    .run();
  if (Number(updated.meta.changes ?? 0) !== 1) throw new Error("Message is not in junk");
  const next = await getMessage(env, id);
  if (!next) throw new Error("Message not found");
  const bot = await getBot(env, next.bot_id);
  if (bot && bot.id !== "_unrouted") await notifyBot(env, bot, next);
  return next;
}

export async function blockMessageSender(env: Env, id: string): Promise<{ blocked: string; blocklist: string[] }> {
  const row = await getMessage(env, id);
  if (!row) throw new Error("Message not found");
  const mailbox = parseMailbox(row.from_addr);
  if (!mailbox) throw new Error("Sender address is not usable");
  const blocklist = await saveInboundList(env, "block", [...parseAllowlistText(await getSetting(env, "inbound_blocklist")), mailbox.address]);
  return { blocked: mailbox.address, blocklist };
}

function listed(mailbox: Mailbox, entries: string[]): boolean {
  return entries.includes(mailbox.address) || entries.includes(mailbox.domain);
}

function allowlisted(mailbox: Mailbox, entries: string[], domains: string[]): boolean {
  if (domainClaimsBotMail(mailbox.domain, domains)) return false;
  const usable = entries.filter((entry) => !domainClaimsBotMail(entryDomain(entry), domains));
  return listed(mailbox, usable);
}

export function domainClaimsBotMail(domain: string, botDomains: string[]): boolean {
  return domainMatches(domain, botDomains);
}

function entryDomain(entry: string): string {
  if (entry.includes("@")) return parseMailbox(entry)?.domain ?? "";
  return entry;
}

function claimsBotDomain(fromAddresses: string[], senderAddresses: string[], envelopeFrom: string, domains: string[]): boolean {
  const candidates = [...fromAddresses, ...senderAddresses];
  const envelope = parseMailbox(envelopeFrom);
  if (envelope) candidates.push(envelope.address);
  return candidates.some((address) => {
    const domain = parseMailbox(address)?.domain ?? address.split("@").at(-1) ?? "";
    return domainClaimsBotMail(domain, domains);
  });
}

async function recentFromSender(env: Env, botId: string, from: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND direction = 'in' AND lower(from_addr) = ? AND created_at >= ?`,
  )
    .bind(botId, from.trim().toLowerCase(), since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function recentAutomatedInbound(env: Env, botId: string, from: string, windowSeconds: number): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND direction = 'in' AND hop_count > 0 AND lower(from_addr) = ? AND created_at >= ?`,
  )
    .bind(botId, from.trim().toLowerCase(), since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const STAMP_WINDOW_MS = 24 * 60 * 60 * 1000;

function quotaPayload(recipients: string[]): string {
  return JSON.stringify(recipients.map((recipient) => ({ id: crypto.randomUUID(), recipient })));
}

/**
 * Reserve one automated reply per recipient in the same statement that checks the window.
 * A full window inserts nothing. Plus-tags collapse to the mailbox, matching the old count.
 */
export async function reserveAutoReplyQuota(
  env: Env,
  botId: string,
  attemptId: string,
  recipients: string[],
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const targets = [
    ...new Set(recipients.map((recipient) => parseMailbox(recipient)?.address).filter((address): address is string => Boolean(address))),
  ];
  if (targets.length === 0) return true;
  const payload = quotaPayload(targets);
  const names = JSON.stringify(targets);
  const now = nowIso();
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO outbound_quota (id, bot_id, attempt_id, kind, recipient, reserved_at, status, created_at, updated_at)
     SELECT json_extract(value, '$.id'), ?, ?, 'auto_reply', json_extract(value, '$.recipient'), ?, 'charged', ?, ?
     FROM json_each(?)
     WHERE NOT EXISTS (
       SELECT 1 FROM json_each(?) AS target
       WHERE (
         SELECT COUNT(*) FROM outbound_quota
         WHERE bot_id = ? AND kind = 'auto_reply' AND status = 'charged'
           AND recipient = target.value AND reserved_at >= ?
       ) >= ?
     )`,
  )
    .bind(botId, attemptId, now, now, now, payload, names, botId, since, limit)
    .run();
  return Number(result.meta.changes) === targets.length;
}

/** Reserve one daily stamp slot per BotMail recipient. The limit and the insert are one statement. */
export async function reserveStampQuota(
  env: Env,
  botId: string,
  attemptId: string,
  recipients: string[],
  limit: number,
): Promise<boolean> {
  if (recipients.length === 0) return true;
  const payload = quotaPayload(recipients);
  const now = nowIso();
  const since = new Date(Date.now() - STAMP_WINDOW_MS).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO outbound_quota (id, bot_id, attempt_id, kind, recipient, reserved_at, status, created_at, updated_at)
     SELECT json_extract(value, '$.id'), ?, ?, 'stamp', json_extract(value, '$.recipient'), ?, 'charged', ?, ?
     FROM json_each(?)
     WHERE (
       SELECT COUNT(*) FROM outbound_quota
       WHERE bot_id = ? AND kind = 'stamp' AND status = 'charged' AND reserved_at >= ?
     ) + ? <= ?`,
  )
    .bind(botId, attemptId, now, now, now, payload, botId, since, recipients.length, limit)
    .run();
  return Number(result.meta.changes) === recipients.length;
}

/** 24h stamp window plus 12h. The floor, not the only window. */
const MIN_QUOTA_RETENTION_MS = 36 * 60 * 60 * 1000;
/** normalizeWindow allows an auto-reply window up to 7 days. */
const MAX_AUTO_REPLY_WINDOW_MS = 604800 * 1000;
const QUOTA_MARGIN_MS = 12 * 60 * 60 * 1000;

/**
 * Drop outbound_quota rows, released ones included, once they are older than
 * max(36h, the longest configurable auto-reply window + 12h). A charge still inside any window stays.
 * Other deletes already in the tree are under review and are not this prune:
 * webhook_setup_codes replacement, webhook_setup_hits pruning, attachment replace in attachments.ts,
 * OAuth KV purge and revokeGrant, the 0004 table rebuild, and setup.mjs --teardown.
 */
export async function pruneOutboundQuota(env: Env, now = Date.now()): Promise<number> {
  const retentionMs = Math.max(MIN_QUOTA_RETENTION_MS, MAX_AUTO_REPLY_WINDOW_MS + QUOTA_MARGIN_MS);
  const cutoff = new Date(now - retentionMs).toISOString();
  const result = await env.DB.prepare(`DELETE FROM outbound_quota WHERE reserved_at < ?`).bind(cutoff).run();
  return Number(result.meta.changes ?? 0);
}

/** Undo a charge that never reached a successful EMAIL.send. The row stays, marked released. */
export async function releaseOutboundQuota(env: Env, botId: string, attemptId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE outbound_quota SET status = 'released', updated_at = ? WHERE bot_id = ? AND attempt_id = ? AND status = 'charged'`,
  )
    .bind(nowIso(), botId, attemptId)
    .run();
}

async function recentStampedFromSender(env: Env, botId: string, from: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE bot_id = ? AND direction = 'in' AND auth_result = 'internal' AND lower(from_addr) = ? AND created_at >= ?`,
  )
    .bind(botId, from.trim().toLowerCase(), since)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}
