import { addressKey, lookupAddress } from "./address-registry";
import { decryptString, encryptString, randomToken, sha256Hex } from "./crypto";
import { getDomainRow, requireEnabledDomain } from "./domains";
import { HttpError } from "./errors";
import { logError } from "./log";
import { normalizeSendPolicy, parseAllowlistText, type SendPolicy } from "./policy";
import { UNROUTED_BOT_ID } from "./seed-bots";

export type BotRow = {
  id: string;
  display_name: string;
  address_local: string;
  domain: string;
  notes: string;
  owner_email: string | null;
  api_key_hash: string | null;
  webhook_url: string | null;
  webhook_key_ct: string | null;
  webhook_key_iv: string | null;
  enabled: number;
  deleted_at: string | null;
  forward_to: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  bot_id: string;
  message_id_header: string | null;
  direction: "in" | "out";
  folder: string;
  status: string;
  from_addr: string;
  to_addrs: string;
  cc_addrs: string | null;
  bcc_addrs: string | null;
  subject: string | null;
  message_date: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
  snippet: string | null;
  text_body: string | null;
  html_body: string | null;
  body_truncated: number;
  has_attachments: number;
  is_read: number;
  plus_tag: string | null;
  r2_key: string | null;
  raw_size: number | null;
  approval_reason: string | null;
  auth_result: string | null;
  auth_passed: number | null;
  quarantine_reason: string | null;
  hop_count: number;
  spam_score: number | null;
  via_alias: string | null;
  created_at: string;
  updated_at: string;
};

export type AttachmentRow = {
  id: string;
  message_id: string;
  bot_id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
  content_id: string | null;
  disposition: string | null;
  inline: number;
};

const ATTACHMENT_COLUMNS = `id, message_id, bot_id, filename, content_type, size_bytes, r2_key, content_id, disposition, inline`;

export const BOT_COLUMNS = `id, display_name, address_local, domain, notes, owner_email, api_key_hash, webhook_url, webhook_key_ct, webhook_key_iv, enabled, deleted_at, forward_to, created_at, updated_at`;
export const MESSAGE_COLUMNS = `id, bot_id, message_id_header, direction, folder, status, from_addr, to_addrs, cc_addrs, bcc_addrs, subject, message_date, thread_id, in_reply_to, references_header, snippet, text_body, html_body, body_truncated, has_attachments, is_read, plus_tag, r2_key, raw_size, approval_reason, auth_result, auth_passed, quarantine_reason, hop_count, spam_score, via_alias, created_at, updated_at`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  } catch {
    return [];
  }
}

export async function getBotByAddress(env: Env, local: string, domain: string): Promise<BotRow | null> {
  return env.DB.prepare(
    `SELECT ${BOT_COLUMNS} FROM bots WHERE address_local = ? AND domain = ? AND enabled = 1 AND deleted_at IS NULL AND id != ?`,
  )
    .bind(local, domain, UNROUTED_BOT_ID)
    .first<BotRow>();
}

export async function listConnectableBots(env: Env): Promise<BotRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${BOT_COLUMNS} FROM bots WHERE enabled = 1 AND deleted_at IS NULL AND id != ? ORDER BY id`,
  )
    .bind(UNROUTED_BOT_ID)
    .all<BotRow>();
  return result.results;
}

export async function getBot(env: Env, id: string): Promise<BotRow | null> {
  return env.DB.prepare(`SELECT ${BOT_COLUMNS} FROM bots WHERE id = ?`).bind(id).first<BotRow>();
}

export async function getBotByKeyHash(env: Env, hash: string): Promise<BotRow | null> {
  return env.DB.prepare(
    `SELECT ${BOT_COLUMNS} FROM bots WHERE api_key_hash = ? AND enabled = 1 AND deleted_at IS NULL AND id != ?`,
  )
    .bind(hash, UNROUTED_BOT_ID)
    .first<BotRow>();
}

const BOT_ID_PATTERN = /^[a-z][a-z0-9._-]{0,62}$/;
const LOCAL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const NOTES_MAX = 2000;
const GENERIC_LABELS = new Set(["bot", "bots", "mail", "email", "mx", "agent", "agents", "inbox"]);

function wellFormed(value: string): boolean {
  return !value.includes("..") && !value.endsWith(".");
}

export function assertBotId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (!BOT_ID_PATTERN.test(normalized) || !wellFormed(normalized)) {
    throw new HttpError("Bot id must start with a letter and use a-z, 0-9, dot, dash, or underscore", 400, "invalid_id");
  }
  return normalized;
}

export function assertLocalPart(local: string): string {
  const normalized = local.trim().toLowerCase();
  if (!LOCAL_PATTERN.test(normalized) || !wellFormed(normalized)) {
    throw new HttpError("Address must be a lowercase mailbox name: a-z, 0-9, dot, dash, or underscore", 400, "invalid_local");
  }
  return normalized;
}

export function normalizeNotes(value: unknown): string {
  return String(value ?? "").replaceAll("\r\n", "\n").trim().slice(0, NOTES_MAX);
}

const OWNER_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER_EMAIL_MAX = 254;

/** A verified Access email, or null when the value is missing or not an email. Never throws. */
export function coerceOwnerEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > OWNER_EMAIL_MAX || !OWNER_EMAIL.test(email)) return null;
  return email;
}

/** Blank clears the owner. Anything else must be an email. */
export function normalizeOwnerEmail(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError("Owner must be an email address", 400, "invalid_owner");
  const email = value.trim().toLowerCase();
  if (!email) return null;
  const coerced = coerceOwnerEmail(email);
  if (!coerced) throw new HttpError("Owner must be an email address", 400, "invalid_owner");
  return coerced;
}

/** The label that tells two domains apart: bot.desk.email gives "desk", bots.example.test gives "example". */
export function domainTag(domain: string): string {
  const labels = domain.split(".").slice(0, -1);
  return labels.find((label) => !GENERIC_LABELS.has(label)) ?? labels[0] ?? domain;
}

/** Ids stay globally unique: herald, then herald.desk, then herald.bot-desk-email, then a numeric suffix. */
export async function suggestBotId(env: Env, local: string, domain: string): Promise<string> {
  const base = /^[a-z]/.test(local) ? local : `bot-${local}`;
  const tidy = (value: string) => value.slice(0, 63).replace(/[._-]+$/, "");
  const candidates = [base, `${base}.${domainTag(domain)}`, `${base}.${domain.replaceAll(".", "-")}`];
  for (let n = 2; n < 50; n += 1) candidates.push(`${tidy(base).slice(0, 59)}-${n}`);
  for (const candidate of candidates) {
    const id = tidy(candidate);
    if (BOT_ID_PATTERN.test(id) && wellFormed(id) && !(await getBot(env, id))) return id;
  }
  return `bot-${randomToken(6).toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`;
}

function configUniqueNames(env: Env): boolean {
  const raw = String(env.UNIQUE_BOT_NAMES ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export async function uniqueBotNames(env: Env): Promise<{ value: boolean; source: "dashboard" | "config"; config: boolean }> {
  const stored = (await getSetting(env, "unique_bot_names")).trim();
  const config = configUniqueNames(env);
  if (stored === "true" || stored === "false") return { value: stored === "true", source: "dashboard", config };
  return { value: config, source: "config", config };
}

export async function duplicateBotNames(env: Env): Promise<Array<{ local: string; addresses: string[] }>> {
  const rows = await env.DB.prepare(
    `SELECT address_local, GROUP_CONCAT(address_local || '@' || domain, ',') AS addresses
       FROM bots WHERE id != ? GROUP BY address_local HAVING COUNT(*) > 1 ORDER BY address_local`,
  )
    .bind(UNROUTED_BOT_ID)
    .all<{ address_local: string; addresses: string }>();
  return rows.results.map((row) => ({ local: row.address_local, addresses: row.addresses.split(",").sort() }));
}

/** `null` returns control to the uniqueBotNames config value. Turning it on fails while duplicates exist. */
export async function saveUniqueBotNames(env: Env, value: boolean | null) {
  const next = value ?? configUniqueNames(env);
  if (next) {
    const duplicates = await duplicateBotNames(env);
    if (duplicates.length > 0) {
      const list = duplicates.map((item) => item.addresses.join(" and ")).join("; ");
      throw new HttpError(`Unique bot names cannot be turned on while names repeat across domains: ${list}`, 409, "duplicates", { duplicates });
    }
  }
  await putSetting(env, "unique_bot_names", value === null ? "" : String(value));
  return uniqueBotNames(env);
}

function archivedBotMessage(address: string, bot: { id: string; display_name: string }): string {
  return `${address} is taken by archived bot ${bot.display_name} (${bot.id}). Restore it?`;
}

export async function assertAddressFree(env: Env, local: string, domain: string): Promise<void> {
  const address = `${local}@${domain}`;
  const taken = await env.DB.prepare(`SELECT id, display_name, deleted_at, enabled FROM bots WHERE address_local = ? AND domain = ?`)
    .bind(local, domain)
    .first<{ id: string; display_name: string; deleted_at: string | null; enabled: number }>();
  if (taken?.deleted_at) {
    throw new HttpError(archivedBotMessage(address, taken), 409, "archived", { conflict: { id: taken.id, address, archived: true } });
  }
  if (taken) {
    const disabled = taken.enabled === 0 ? " That mailbox is disabled and the address stays reserved." : "";
    throw new HttpError(`${address} is already taken by ${taken.display_name} (${taken.id})${disabled}`, 409, "address_taken", {
      conflict: { id: taken.id, address },
    });
  }
  const route = await env.DB.prepare(`SELECT id, kind, target, deleted_at FROM routes WHERE local_part = ? AND domain = ?`)
    .bind(local, domain)
    .first<{ id: string; kind: string; target: string; deleted_at: string | null }>();
  if (route?.deleted_at) {
    throw new HttpError(`${address} is taken by an archived routing rule. Restore it?`, 409, "archived", {
      conflict: { route: route.id, address, archived: true },
    });
  }
  if (route?.kind === "alias") {
    throw new HttpError(`${address} is already an alias. Remove that alias before using the address.`, 409, "address_taken", {
      conflict: { route: route.id, address },
    });
  }
  if (route) {
    throw new HttpError(`${address} is already a routing rule (${route.kind} → ${route.target}). Remove the rule first.`, 409, "address_taken", {
      conflict: { route: route.id, address },
    });
  }
  const registered = await lookupAddress(env, address);
  if (registered?.kind === "mailbox") {
    const owner = await getBot(env, registered.owner_id);
    if (owner?.deleted_at) {
      throw new HttpError(archivedBotMessage(address, owner), 409, "archived", { conflict: { id: owner.id, address, archived: true } });
    }
    if (owner) {
      throw new HttpError(`${address} is already taken by ${owner.display_name} (${owner.id})`, 409, "address_taken", {
        conflict: { id: owner.id, address },
      });
    }
    throw new HttpError(`${address} stays reserved.`, 409, "address_taken", { conflict: { address } });
  }
  if (registered?.kind === "alias") {
    throw new HttpError(`${address} is already an alias. Remove that alias before using the address.`, 409, "address_taken", {
      conflict: { address },
    });
  }
  if (registered) {
    throw new HttpError(`${address} is already a routing address. Remove that rule first.`, 409, "address_taken", {
      conflict: { address },
    });
  }
  if (!(await uniqueBotNames(env)).value) return;
  const other = await env.DB.prepare(
    `SELECT id, display_name, domain, deleted_at FROM bots WHERE address_local = ? AND id != ? ORDER BY (deleted_at IS NULL) DESC, domain LIMIT 1`,
  )
    .bind(local, UNROUTED_BOT_ID)
    .first<{ id: string; display_name: string; domain: string; deleted_at: string | null }>();
  if (other?.deleted_at) {
    throw new HttpError(
      `The name "${local}" is taken by archived bot ${other.display_name} (${other.id}) at ${local}@${other.domain}. Restore it?`,
      409,
      "archived",
      { conflict: { id: other.id, address: `${local}@${other.domain}`, archived: true } },
    );
  }
  if (other) {
    throw new HttpError(
      `A bot named "${local}" already exists at ${local}@${other.domain} (${other.id}). Unique bot names is on, so a name can be used on one domain only.`,
      409,
      "name_taken",
      { conflict: { id: other.id, address: `${local}@${other.domain}` } },
    );
  }
}

export type CreateBotInput = {
  id?: string;
  local?: string;
  domain?: string;
  displayName?: string;
  notes?: string;
  /** Verified Access email. Null and omitted both store no owner. */
  ownerEmail?: string | null;
};

export async function createBot(env: Env, input: CreateBotInput): Promise<{ bot: BotRow; apiKey: string }> {
  const local = assertLocalPart(input.local?.trim() ? input.local : (input.id ?? ""));
  const domain = await requireEnabledDomain(env, input.domain);
  await assertAddressFree(env, local, domain);
  const botId = input.id?.trim() ? assertBotId(input.id) : await suggestBotId(env, local, domain);
  const existing = await getBot(env, botId);
  if (existing?.deleted_at) {
    throw new HttpError(archivedBotMessage(`${existing.address_local}@${existing.domain}`, existing), 409, "archived", {
      conflict: { id: existing.id, address: `${existing.address_local}@${existing.domain}`, archived: true },
    });
  }
  if (existing) {
    throw new HttpError(
      `Bot id ${botId} is already used by ${existing.address_local}@${existing.domain}. Pick another id, for example ${await suggestBotId(env, local, domain)}.`,
      409,
      "id_taken",
      { conflict: { id: existing.id, address: `${existing.address_local}@${existing.domain}` } },
    );
  }
  const stamp = nowIso();
  const name = (input.displayName || local).trim().slice(0, 80) || local;
  const address = addressKey(local, domain);
  const ownerEmail = input.ownerEmail == null || input.ownerEmail === "" ? null : normalizeOwnerEmail(input.ownerEmail);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO address_registry (address, kind, owner_id, created_at) VALUES (?, 'mailbox', ?, ?)`).bind(
        address,
        botId,
        stamp,
      ),
      env.DB.prepare(
        `INSERT INTO bots (id, display_name, address_local, domain, notes, owner_email, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(botId, name, local, domain, normalizeNotes(input.notes), ownerEmail, stamp, stamp),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      await assertAddressFree(env, local, domain);
      throw new HttpError(`${address} is already taken`, 409, "address_taken", { conflict: { address } });
    }
    throw error;
  }
  const apiKey = await rotateBotKey(env, botId);
  const bot = await getBot(env, botId);
  if (!bot) throw new Error("Bot insert failed");
  return { bot, apiKey };
}

function isUniqueError(error: unknown): boolean {
  return /UNIQUE/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Change the primary address. The mailbox id, mail, webhook, API key hash, and OAuth
 * connection stay. The previous address becomes an alias that still delivers here.
 */
export async function renameBotAddress(env: Env, bot: BotRow, localInput: string, domainInput?: string): Promise<BotRow> {
  const local = assertLocalPart(localInput);
  const domain = await requireEnabledDomain(env, domainInput ?? bot.domain);
  const next = addressKey(local, domain);
  const current = addressKey(bot.address_local, bot.domain);
  if (next === current) return bot;
  await assertAddressFree(env, local, domain);
  const routeId = crypto.randomUUID();
  const stamp = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO address_registry (address, kind, owner_id, created_at) VALUES (?, 'mailbox', ?, ?)`).bind(
        next,
        bot.id,
        stamp,
      ),
      env.DB.prepare(`UPDATE address_registry SET kind = 'alias', owner_id = ? WHERE address = ? AND owner_id = ?`).bind(
        routeId,
        current,
        bot.id,
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO address_registry (address, kind, owner_id, created_at) VALUES (?, 'alias', ?, ?)`,
      ).bind(current, routeId, stamp),
      env.DB.prepare(
        `INSERT INTO routes (id, kind, local_part, domain, target, enabled, created_at, updated_at)
         VALUES (?, 'alias', ?, ?, ?, 1, ?, ?)`,
      ).bind(routeId, bot.address_local, bot.domain, bot.id, stamp, stamp),
      env.DB.prepare(`INSERT INTO alias_targets (route_id, bot_id, created_at) VALUES (?, ?, ?)`).bind(routeId, bot.id, stamp),
      env.DB.prepare(`UPDATE bots SET address_local = ?, domain = ?, updated_at = ? WHERE id = ?`).bind(local, domain, stamp, bot.id),
    ]);
  } catch (error) {
    if (isUniqueError(error)) {
      await assertAddressFree(env, local, domain);
      throw new HttpError(`${next} is already taken`, 409, "address_taken", { conflict: { address: next } });
    }
    throw error;
  }
  const updated = await getBot(env, bot.id);
  if (!updated) throw new Error("Bot not found");
  return updated;
}

async function normalizeForwardTarget(env: Env, botId: string, value: string | null): Promise<string | null> {
  const id = value?.trim().toLowerCase() ?? "";
  if (!id) return null;
  if (id === botId) throw new HttpError("A mailbox cannot forward to itself", 400, "forward_target");
  const target = await getBot(env, id);
  if (!target || target.deleted_at || target.id === UNROUTED_BOT_ID) {
    throw new HttpError("Forward target must be another BotMail mailbox", 400, "forward_target");
  }
  return target.id;
}

function requireActiveBot(bot: BotRow | null): BotRow {
  if (!bot || bot.id === UNROUTED_BOT_ID) throw new Error("Bot not found");
  if (bot.deleted_at) throw new Error("Bot is archived. Restore it first.");
  return bot;
}

export async function rotateBotKey(env: Env, id: string): Promise<string> {
  const botId = id.trim().toLowerCase();
  requireActiveBot(await getBot(env, botId));
  const apiKey = `bm_${botId}_${randomToken(32)}`;
  const hash = await sha256Hex(apiKey);
  await env.DB.prepare(`UPDATE bots SET api_key_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(hash, nowIso(), botId)
    .run();
  return apiKey;
}

export const WEBHOOK_KEY_REQUIRED = "Routine Webhook key required";
export const WEBHOOK_KEY_REDACTED = "Routine Webhook key was redacted";

/** The literal a masked chat form substitutes into a tool argument. Ten bytes. Never a real key. */
const REDACTED_WEBHOOK_KEY = "[REDACTED]";

/** Drop surrounding whitespace and one leading "Bearer " so a pasted Authorization value still stores the key. */
export function normalizeWebhookKey(key: string): string {
  return key.trim().replace(/^bearer(?:\s+|$)/i, "").trim();
}

/**
 * Save the wake webhook. A provided key is stored only after Bearer and whitespace are stripped.
 * An empty result is rejected and nothing is written. Omitting the key keeps a key that is already stored.
 * Queued deliveries are cancelled so a retry cannot post the current key to a previous URL.
 */
export async function setBotWebhook(env: Env, id: string, url: string, key?: string): Promise<void> {
  const bot = requireActiveBot(await getBot(env, id.trim().toLowerCase()));
  if (bot.enabled !== 1) throw new Error("Bot is disabled");
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith("https://")) throw new Error("Webhook URL must be https");
  const provided = key !== undefined;
  const trimmedKey = provided ? normalizeWebhookKey(key) : "";
  if ((provided && !trimmedKey) || (!trimmedKey && !bot.webhook_key_ct)) throw new Error(WEBHOOK_KEY_REQUIRED);
  if (trimmedKey === REDACTED_WEBHOOK_KEY) throw new Error(WEBHOOK_KEY_REDACTED);
  const stamp = nowIso();
  const urlUpdate = trimmedKey
    ? await sealedWebhookUpdate(env, bot.id, trimmedUrl, trimmedKey, stamp)
    : env.DB.prepare(
        `UPDATE bots SET webhook_url = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
      ).bind(trimmedUrl, stamp, bot.id);
  const [saved] = await env.DB.batch([urlUpdate, cancelQueuedDeliveries(env, bot.id, "webhook changed", stamp)]);
  if (Number(saved?.meta.changes ?? 0) !== 1) throw new Error("Bot is disabled");
}

async function sealedWebhookUpdate(env: Env, botId: string, url: string, key: string, stamp: string): Promise<D1PreparedStatement> {
  if (!env.DATA_KEY) throw new Error("DATA_KEY secret is not configured");
  const sealed = await encryptString(env.DATA_KEY, key);
  return env.DB.prepare(
    `UPDATE bots SET webhook_url = ?, webhook_key_ct = ?, webhook_key_iv = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
  ).bind(url, sealed.ciphertext, sealed.iv, stamp, botId);
}

/** Pending and failed deliveries are the ones drain will retry. Leave success rows alone. */
function cancelQueuedDeliveries(env: Env, botId: string, reason: string, stamp: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE webhook_deliveries
     SET status = 'cancelled', last_error = ?, updated_at = ?
     WHERE bot_id = ? AND status IN ('pending', 'failed')`,
  ).bind(reason, stamp, botId);
}

/**
 * A disable request clears the API key hash and webhook ciphertext, cancels queued
 * deliveries, marks setup codes used, and marks the OAuth connection revoked.
 * Repeating the request clears again. Turning the bot back on restores none of that.
 * Reveal a new key or Connect again, and save the webhook again.
 */
export async function updateBot(
  env: Env,
  id: string,
  patch: {
    displayName?: string;
    enabled?: boolean;
    notes?: string;
    addressLocal?: string;
    domain?: string;
    forwardTo?: string | null;
  },
): Promise<BotRow> {
  let bot = requireActiveBot(await getBot(env, id.trim().toLowerCase()));
  if (patch.addressLocal !== undefined || patch.domain !== undefined) {
    const nextLocal = patch.addressLocal ?? bot.address_local;
    const nextDomain = patch.domain ?? bot.domain;
    if (nextLocal.trim().toLowerCase() !== bot.address_local || nextDomain.trim().toLowerCase() !== bot.domain) {
      bot = await renameBotAddress(env, bot, nextLocal, nextDomain);
    }
  }
  const displayName = (patch.displayName ?? bot.display_name).trim().slice(0, 80) || bot.id;
  const enabled = patch.enabled === undefined ? bot.enabled : patch.enabled ? 1 : 0;
  const notes = patch.notes === undefined ? bot.notes : normalizeNotes(patch.notes);
  const forwardTo = patch.forwardTo === undefined ? bot.forward_to : await normalizeForwardTarget(env, bot.id, patch.forwardTo);
  const stamp = nowIso();
  if (patch.enabled === false) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE bots
         SET display_name = ?, enabled = 0, notes = ?, forward_to = ?, api_key_hash = NULL, webhook_key_ct = NULL, webhook_key_iv = NULL, updated_at = ?
         WHERE id = ?`,
      ).bind(displayName, notes, forwardTo, stamp, bot.id),
      cancelQueuedDeliveries(env, bot.id, "bot disabled", stamp),
      spendWebhookSetupCodes(env, bot.id, stamp),
      revokeConnection(env, bot.id, stamp),
    ]);
    await revokeStoredGrants(env, bot.id);
  } else {
    await env.DB.prepare(`UPDATE bots SET display_name = ?, enabled = ?, notes = ?, forward_to = ?, updated_at = ? WHERE id = ?`)
      .bind(displayName, enabled, notes, forwardTo, stamp, bot.id)
      .run();
  }
  const next = await getBot(env, bot.id);
  if (!next) throw new Error("Bot not found");
  return next;
}

/** Backfill or correct the owner. Works for archived mailboxes. Does not change mail, keys, or the connector. */
export async function setBotOwner(env: Env, id: string, value: unknown): Promise<BotRow> {
  const bot = await getBot(env, id.trim().toLowerCase());
  if (!bot || bot.id === UNROUTED_BOT_ID) throw new Error("Bot not found");
  const owner = normalizeOwnerEmail(value);
  await env.DB.prepare(`UPDATE bots SET owner_email = ?, updated_at = ? WHERE id = ?`).bind(owner, nowIso(), bot.id).run();
  const next = await getBot(env, bot.id);
  if (!next) throw new Error("Bot not found");
  return next;
}

/** Archive. The row, its mail, and its notes stay. The API key hash and webhook ciphertext are cleared, the connector is revoked, and queued deliveries are cancelled. */
export async function deleteBot(env: Env, id: string): Promise<void> {
  const bot = await getBot(env, id.trim().toLowerCase());
  if (!bot || bot.id === UNROUTED_BOT_ID) throw new Error("Bot not found");
  if (bot.deleted_at) return;
  const stamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bots
       SET deleted_at = ?, enabled = 0, api_key_hash = NULL, webhook_key_ct = NULL, webhook_key_iv = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(stamp, stamp, bot.id),
    cancelQueuedDeliveries(env, bot.id, "bot archived", stamp),
    spendWebhookSetupCodes(env, bot.id, stamp),
    revokeConnection(env, bot.id, stamp),
  ]);
  await revokeStoredGrants(env, bot.id);
}

function revokeConnection(env: Env, botId: string, stamp: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO oauth_connection (bot_id, grant_id, created_at, revoked_at, last_revoked_at) VALUES (?, 'revoked', ?, ?, ?)
     ON CONFLICT(bot_id) DO UPDATE SET revoked_at = excluded.revoked_at, last_revoked_at = excluded.last_revoked_at`,
  ).bind(botId, stamp, stamp, stamp);
}

function spendWebhookSetupCodes(env: Env, botId: string, stamp: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE webhook_setup_codes SET used_at = ? WHERE bot_id = ? AND used_at IS NULL`).bind(stamp, botId);
}

/** KV grants are not D1 rows. A failure here still leaves revoked_at set, so the old token cannot call the mailbox. */
async function revokeStoredGrants(env: Env, botId: string): Promise<void> {
  try {
    const { revokeBotGrants } = await import("./oauth");
    await revokeBotGrants(env, botId);
  } catch (error) {
    logError("oauth_revoke_failed", {
      bot: botId,
      error: error instanceof Error ? error.message : "oauth revoke failed",
    });
  }
}

/** Restore keeps the id, notes, and mail. The API key, webhook ciphertext, and connector stay cleared. */
export async function restoreBot(env: Env, id: string): Promise<BotRow> {
  const bot = await getBot(env, id.trim().toLowerCase());
  if (!bot || bot.id === UNROUTED_BOT_ID) throw new Error("Bot not found");
  if (!bot.deleted_at) return bot;
  const domain = await getDomainRow(env, bot.domain);
  if (domain?.deleted_at) {
    throw new HttpError(`Restore ${bot.domain} before restoring this bot.`, 409, "domain_archived");
  }
  await env.DB.prepare(`UPDATE bots SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), bot.id).run();
  const next = await getBot(env, bot.id);
  if (!next) throw new Error("Bot not found");
  return next;
}

export async function webhookKey(env: Env, bot: Pick<BotRow, "id" | "webhook_key_ct" | "webhook_key_iv">): Promise<string | null> {
  if (!bot.webhook_key_ct || !bot.webhook_key_iv) return null;
  if (!env.DATA_KEY) return null;
  try {
    return await decryptString(env.DATA_KEY, bot.webhook_key_ct, bot.webhook_key_iv);
  } catch (error) {
    logError("webhook_key_decrypt_failed", {
      bot: bot.id,
      error: error instanceof Error ? error.message : "decrypt failed",
    });
    return null;
  }
}

export async function getSetting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

export async function putSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(key, value)
    .run();
}

export async function loadSendConfig(env: Env): Promise<{ policy: SendPolicy; allowlist: string[] }> {
  const policyRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'send_policy'`).first<{ value: string }>();
  const listRow = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'send_allowlist'`).first<{ value: string }>();
  const source = await getSetting(env, "send_policy_source");
  const fromEnv = normalizeSendPolicy(env.SEND_POLICY);
  const fromD1 = normalizeSendPolicy(policyRow?.value);
  const policy: SendPolicy = source === "dashboard" && fromD1 ? fromD1 : (fromEnv ?? fromD1 ?? "approval");
  const allowlist = [
    ...parseAllowlistText(String(env.SEND_ALLOWLIST || "")),
    ...parseAllowlistText(listRow?.value || "[]"),
  ];
  return { policy, allowlist };
}

export async function saveSendPolicy(
  env: Env,
  policy: SendPolicy,
  source?: "dashboard" | "config",
): Promise<{ stored: SendPolicy; active: SendPolicy; lockedByEnv: boolean }> {
  await putSetting(env, "send_policy", policy);
  if (source) await putSetting(env, "send_policy_source", source);
  const active = await loadSendConfig(env);
  const lockedByEnv = (await getSetting(env, "send_policy_source")) !== "dashboard" && normalizeSendPolicy(env.SEND_POLICY) !== null;
  return {
    stored: policy,
    active: active.policy,
    lockedByEnv,
  };
}

export async function saveAllowlist(env: Env, entries: string[]): Promise<string[]> {
  const normalized = parseAllowlistText(JSON.stringify(entries));
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('send_allowlist', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(normalized))
    .run();
  return (await loadSendConfig(env)).allowlist;
}

export type MessageDraft = {
  id?: string;
  botId: string;
  messageIdHeader?: string | null;
  direction: "in" | "out";
  folder: string;
  status: string;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  subject?: string | null;
  messageDate?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  snippet?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  bodyTruncated?: boolean;
  hasAttachments?: boolean;
  isRead?: boolean;
  plusTag?: string | null;
  r2Key?: string | null;
  rawSize?: number | null;
  approvalReason?: string | null;
  authResult?: string | null;
  authPassed?: boolean | null;
  quarantineReason?: string | null;
  hopCount?: number;
  spamScore?: number | null;
  viaAlias?: string | null;
};

export async function findDuplicateMessage(
  env: Env,
  botId: string,
  messageIdHeader: string,
  direction: "in" | "out",
): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE bot_id = ? AND message_id_header = ? AND direction = ?`,
  )
    .bind(botId, messageIdHeader, direction)
    .first<MessageRow>();
}

export async function insertMessage(env: Env, draft: MessageDraft): Promise<MessageRow> {
  const stored = await insertMessageClaimingStamp(env, draft, null);
  if (stored === "duplicate") throw new Error("Message already exists");
  return stored;
}

/** Inserts the message and, when a stamp verified, claims it in the same D1 batch. A unique failure leaves the first copy. */
export async function insertMessageClaimingStamp(
  env: Env,
  draft: MessageDraft,
  claim: { stampId: string; botId: string } | null,
): Promise<MessageRow | "duplicate"> {
  const id = draft.id || crypto.randomUUID();
  const stamp = nowIso();
  const message = messageInsert(env, draft, id, stamp);
  try {
    if (claim) {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO inbound_stamps (stamp_id, bot_id, created_at) VALUES (?, ?, ?)`).bind(
          claim.stampId,
          claim.botId,
          stamp,
        ),
        message,
      ]);
    } else {
      await message.run();
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (/unique|constraint/i.test(messageText)) return "duplicate";
    throw error;
  }
  const row = await getMessage(env, id);
  if (!row) throw new Error("Message insert failed");
  return row;
}

function messageInsert(env: Env, draft: MessageDraft, id: string, stamp: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO messages (
      id, bot_id, message_id_header, direction, folder, status, from_addr, to_addrs, cc_addrs, bcc_addrs,
      subject, message_date, thread_id, in_reply_to, references_header, snippet, text_body, html_body,
      body_truncated, has_attachments, is_read, plus_tag, r2_key, raw_size, approval_reason,
      auth_result, auth_passed, quarantine_reason, hop_count, spam_score, via_alias, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    draft.botId,
    draft.messageIdHeader ?? null,
    draft.direction,
    draft.folder,
    draft.status,
    draft.fromAddr,
    JSON.stringify(draft.toAddrs),
    JSON.stringify(draft.ccAddrs ?? []),
    JSON.stringify(draft.bccAddrs ?? []),
    draft.subject ?? null,
    draft.messageDate ?? stamp,
    draft.threadId ?? null,
    draft.inReplyTo ?? null,
    draft.referencesHeader ?? null,
    draft.snippet ?? null,
    draft.textBody ?? null,
    draft.htmlBody ?? null,
    draft.bodyTruncated ? 1 : 0,
    draft.hasAttachments ? 1 : 0,
    draft.isRead ? 1 : 0,
    draft.plusTag ?? null,
    draft.r2Key ?? null,
    draft.rawSize ?? null,
    draft.approvalReason ?? null,
    draft.authResult ?? null,
    draft.authPassed == null ? null : draft.authPassed ? 1 : 0,
    draft.quarantineReason ?? null,
    draft.hopCount ?? 0,
    draft.spamScore ?? null,
    draft.viaAlias ?? null,
    stamp,
    stamp,
  );
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
}

export async function getMessageForBot(env: Env, botId: string, id: string): Promise<MessageRow | null> {
  return env.DB.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND bot_id = ?`)
    .bind(id, botId)
    .first<MessageRow>();
}

export async function updateMessage(env: Env, id: string, patch: Partial<MessageDraft> & { status?: string }): Promise<void> {
  const current = await getMessage(env, id);
  if (!current) throw new Error("Message not found");
  const stamp = nowIso();
  await env.DB.prepare(
    `UPDATE messages SET
      message_id_header = ?, direction = ?, folder = ?, status = ?, from_addr = ?, to_addrs = ?, cc_addrs = ?,
      bcc_addrs = ?, subject = ?, message_date = ?, thread_id = ?, in_reply_to = ?, references_header = ?,
      snippet = ?, text_body = ?, html_body = ?, body_truncated = ?, has_attachments = ?, is_read = ?,
      plus_tag = ?, r2_key = ?, raw_size = ?, approval_reason = ?, hop_count = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      patch.messageIdHeader === undefined ? current.message_id_header : patch.messageIdHeader,
      patch.direction ?? current.direction,
      patch.folder ?? current.folder,
      patch.status ?? current.status,
      patch.fromAddr ?? current.from_addr,
      patch.toAddrs ? JSON.stringify(patch.toAddrs) : current.to_addrs,
      patch.ccAddrs ? JSON.stringify(patch.ccAddrs) : current.cc_addrs,
      patch.bccAddrs ? JSON.stringify(patch.bccAddrs) : current.bcc_addrs,
      patch.subject === undefined ? current.subject : patch.subject,
      patch.messageDate === undefined ? current.message_date : patch.messageDate,
      patch.threadId === undefined ? current.thread_id : patch.threadId,
      patch.inReplyTo === undefined ? current.in_reply_to : patch.inReplyTo,
      patch.referencesHeader === undefined ? current.references_header : patch.referencesHeader,
      patch.snippet === undefined ? current.snippet : patch.snippet,
      patch.textBody === undefined ? current.text_body : patch.textBody,
      patch.htmlBody === undefined ? current.html_body : patch.htmlBody,
      patch.bodyTruncated === undefined ? current.body_truncated : patch.bodyTruncated ? 1 : 0,
      patch.hasAttachments === undefined ? current.has_attachments : patch.hasAttachments ? 1 : 0,
      patch.isRead === undefined ? current.is_read : patch.isRead ? 1 : 0,
      patch.plusTag === undefined ? current.plus_tag : patch.plusTag,
      patch.r2Key === undefined ? current.r2_key : patch.r2Key,
      patch.rawSize === undefined ? current.raw_size : patch.rawSize,
      patch.approvalReason === undefined ? current.approval_reason : patch.approvalReason,
      patch.hopCount === undefined ? current.hop_count : patch.hopCount,
      stamp,
      id,
    )
    .run();
}

export async function insertAttachment(env: Env, row: AttachmentRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, bot_id, filename, content_type, size_bytes, r2_key, content_id, disposition, inline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.message_id,
      row.bot_id,
      row.filename,
      row.content_type,
      row.size_bytes,
      row.r2_key,
      row.content_id,
      row.disposition,
      row.inline ? 1 : 0,
    )
    .run();
}

export async function listAttachments(env: Env, messageId: string, botId: string): Promise<AttachmentRow[]> {
  const result = await env.DB.prepare(
    `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE message_id = ? AND bot_id = ? ORDER BY filename`,
  )
    .bind(messageId, botId)
    .all<AttachmentRow>();
  return result.results;
}

export async function getAttachmentForBot(env: Env, botId: string, attachmentId: string): Promise<AttachmentRow | null> {
  return env.DB.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ? AND bot_id = ?`)
    .bind(attachmentId, botId)
    .first<AttachmentRow>();
}

export async function resolveThreadId(env: Env, botId: string, candidates: string[]): Promise<string | null> {
  const ids = [...new Set(candidates.map((id) => id.trim()).filter(Boolean))].slice(0, 20);
  if (ids.length === 0) return null;
  const placeholders = ids.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT thread_id FROM messages
     WHERE bot_id = ? AND message_id_header IN (${placeholders}) AND thread_id IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`,
  )
    .bind(botId, ...ids)
    .first<{ thread_id: string }>();
  return row?.thread_id ?? null;
}
