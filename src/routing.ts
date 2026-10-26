import { botMailbox, parseMailbox } from "./address";
import { addressKey } from "./address-registry";
import { BOT_COLUMNS, getBot, nowIso, type BotRow } from "./db";
import { allDomains, getDomainRow, requireEnabledDomain } from "./domains";
import { HttpError } from "./errors";
import { UNROUTED_BOT_ID } from "./seed-bots";

export type RouteRow = {
  id: string;
  kind: "alias" | "forward";
  local_part: string;
  domain: string;
  target: string;
  enabled: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RouteView = RouteRow & { targets: string[] };

export type InboundTarget = {
  bot: BotRow;
  viaAlias: string | null;
  /** Active mailbox that also receives a copy when `bot` is disabled. Never chained. */
  forwardTo: BotRow | null;
};

export type RecipientDecision =
  | { action: "deliver"; targets: InboundTarget[] }
  | { action: "forward"; rcpt: string }
  | { action: "reject"; reason: string }
  | { action: "unrouted" };

const LOCAL_PART = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ROUTE_COLUMNS = "id, kind, local_part, domain, target, enabled, deleted_at, created_at, updated_at";

async function forwardOnDisable(env: Env, bot: BotRow): Promise<BotRow | null> {
  if (!bot.forward_to || bot.forward_to === bot.id) return null;
  const target = await getBot(env, bot.forward_to);
  if (!target || target.enabled !== 1 || target.deleted_at || target.id === UNROUTED_BOT_ID || target.id === bot.id) return null;
  return target;
}

export async function aliasTargetIds(env: Env, route: Pick<RouteRow, "id" | "target" | "kind">): Promise<string[]> {
  if (route.kind !== "alias") return [];
  const rows = await env.DB.prepare(
    `SELECT bot_id FROM alias_targets WHERE route_id = ? AND removed_at IS NULL ORDER BY created_at, bot_id`,
  )
    .bind(route.id)
    .all<{ bot_id: string }>();
  if (rows.results.length > 0) return rows.results.map((row) => row.bot_id);
  // A removed row means the junction table is the source of truth. Do not fall back to routes.target.
  const removed = await env.DB.prepare(`SELECT 1 AS present FROM alias_targets WHERE route_id = ? AND removed_at IS NOT NULL LIMIT 1`)
    .bind(route.id)
    .first<{ present: number }>();
  if (removed) return [];
  return route.target ? [route.target] : [];
}

/** `domain` must already be an enabled BotMail domain; inbound checks that before it calls this. */
export async function resolveRecipient(env: Env, local: string, domain: string): Promise<RecipientDecision> {
  const direct = await env.DB.prepare(
    `SELECT ${BOT_COLUMNS} FROM bots WHERE address_local = ? AND domain = ? AND deleted_at IS NULL AND id != ?`,
  )
    .bind(local, domain, UNROUTED_BOT_ID)
    .first<BotRow>();
  if (direct?.enabled === 1) return { action: "deliver", targets: [{ bot: direct, viaAlias: null, forwardTo: null }] };
  if (direct?.forward_to) {
    return { action: "deliver", targets: [{ bot: direct, viaAlias: null, forwardTo: await forwardOnDisable(env, direct) }] };
  }

  // An archived mailbox keeps the address. New mail for it is held in Unrouted, not rejected and not delivered.
  const archived = await env.DB.prepare(`SELECT id FROM bots WHERE address_local = ? AND domain = ? AND deleted_at IS NOT NULL AND id != ?`)
    .bind(local, domain, UNROUTED_BOT_ID)
    .first<{ id: string }>();
  if (archived) return { action: "unrouted" };

  const route = await env.DB.prepare(
    `SELECT ${ROUTE_COLUMNS} FROM routes WHERE local_part = ? AND domain = ? AND enabled = 1 AND deleted_at IS NULL`,
  )
    .bind(local, domain)
    .first<RouteRow>();

  if (route?.kind === "alias") {
    const viaAlias = addressKey(local, domain);
    const targets: InboundTarget[] = [];
    for (const id of await aliasTargetIds(env, route)) {
      const target = await getBot(env, id);
      if (!target || target.deleted_at || target.id === UNROUTED_BOT_ID) continue;
      if (target.enabled === 1) {
        targets.push({ bot: target, viaAlias, forwardTo: null });
        continue;
      }
      if (target.forward_to) targets.push({ bot: target, viaAlias, forwardTo: await forwardOnDisable(env, target) });
    }
    if (targets.length > 0) return { action: "deliver", targets };
  }
  if (route?.kind === "forward" && route.target.includes("@")) {
    return { action: "forward", rcpt: route.target };
  }

  const policy = await readSetting(env, "unknown_policy");
  if (policy === "reject") {
    return { action: "reject", reason: "Unknown recipient" };
  }
  if (policy === "default_bot") {
    const id = (await readSetting(env, "unknown_bot")).trim().toLowerCase();
    const target = id ? await getBot(env, id) : null;
    if (target && target.enabled === 1 && !target.deleted_at && target.id !== UNROUTED_BOT_ID) {
      return { action: "deliver", targets: [{ bot: target, viaAlias: null, forwardTo: null }] };
    }
  }
  return { action: "unrouted" };
}

async function routeView(env: Env, row: RouteRow): Promise<RouteView> {
  return { ...row, targets: await aliasTargetIds(env, row) };
}

export async function listRoutes(env: Env, includeArchived = false): Promise<RouteView[]> {
  const result = await env.DB.prepare(
    `SELECT ${ROUTE_COLUMNS} FROM routes WHERE (? = 1 OR deleted_at IS NULL) ORDER BY domain, local_part`,
  )
    .bind(includeArchived ? 1 : 0)
    .all<RouteRow>();
  const links = await env.DB.prepare(
    `SELECT route_id, bot_id FROM alias_targets WHERE removed_at IS NULL ORDER BY created_at, bot_id`,
  ).all<{
    route_id: string;
    bot_id: string;
  }>();
  const removed = await env.DB.prepare(`SELECT DISTINCT route_id FROM alias_targets WHERE removed_at IS NOT NULL`).all<{
    route_id: string;
  }>();
  const byRoute = new Map<string, string[]>();
  for (const link of links.results) {
    const list = byRoute.get(link.route_id) ?? [];
    list.push(link.bot_id);
    byRoute.set(link.route_id, list);
  }
  const removedRoutes = new Set(removed.results.map((row) => row.route_id));
  return result.results.map((route) => ({
    ...route,
    targets:
      route.kind === "alias"
        ? (byRoute.get(route.id) ?? (removedRoutes.has(route.id) ? [] : route.target ? [route.target] : []))
        : [],
  }));
}

async function resolveAliasTargets(env: Env, values: string[]): Promise<string[]> {
  const ids = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) throw new Error("An alias needs at least one mailbox");
  for (const id of ids) {
    const target = await getBot(env, id);
    if (!target || target.deleted_at || target.id === UNROUTED_BOT_ID) throw new Error("alias target must be a bot");
  }
  return ids;
}

export async function createRoute(
  env: Env,
  input: { kind: string; localPart: string; target?: string; targets?: string[]; domain?: string },
): Promise<RouteView> {
  const kind = input.kind === "forward" ? "forward" : input.kind === "alias" ? "alias" : "";
  if (!kind) throw new Error('kind must be "alias" or "forward"');
  const localPart = input.localPart.trim().toLowerCase();
  if (!LOCAL_PART.test(localPart)) throw new Error("local part must be a lowercase mailbox name");
  const domain = await requireEnabledDomain(env, input.domain);
  const address = addressKey(localPart, domain);
  const bot = await env.DB.prepare(`SELECT id, display_name, deleted_at, enabled FROM bots WHERE address_local = ? AND domain = ?`)
    .bind(localPart, domain)
    .first<{ id: string; display_name: string; deleted_at: string | null; enabled: number }>();
  if (bot?.deleted_at) {
    throw new HttpError(`${address} is taken by archived bot ${bot.display_name} (${bot.id}). Restore it?`, 409, "archived");
  }
  if (bot) {
    const disabled = bot.enabled === 0 ? " That mailbox is disabled and the address stays reserved." : "";
    throw new HttpError(`${address} is already the mailbox of bot ${bot.id}${disabled}`, 409, "address_taken");
  }
  const existing = await env.DB.prepare(`SELECT id, deleted_at FROM routes WHERE local_part = ? AND domain = ?`)
    .bind(localPart, domain)
    .first<{ id: string; deleted_at: string | null }>();
  if (existing?.deleted_at) throw new HttpError(`${address} is taken by an archived routing rule. Restore it?`, 409, "archived");
  if (existing) throw new HttpError(`${address} already has a routing rule`, 409, "address_taken");
  const aliasTargets = kind === "alias" ? await resolveAliasTargets(env, input.targets?.length ? input.targets : [input.target ?? ""]) : [];
  const target = kind === "alias" ? aliasTargets[0] : await forwardTarget(env, input.target ?? "");
  if (!target) throw new Error(kind === "alias" ? "An alias needs at least one mailbox" : "forward target must be an email address");
  const stamp = nowIso();
  const id = crypto.randomUUID();
  const statements = [
    env.DB.prepare(`INSERT INTO address_registry (address, kind, owner_id, created_at) VALUES (?, ?, ?, ?)`).bind(address, kind, id, stamp),
    env.DB.prepare(
      `INSERT INTO routes (id, kind, local_part, domain, target, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, kind, localPart, domain, target, stamp, stamp),
  ];
  for (const botId of aliasTargets) {
    statements.push(env.DB.prepare(`INSERT INTO alias_targets (route_id, bot_id, created_at) VALUES (?, ?, ?)`).bind(id, botId, stamp));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) {
      throw new HttpError(`${address} is already taken`, 409, "address_taken", { conflict: { address } });
    }
    throw error;
  }
  const row = await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first<RouteRow>();
  if (!row) throw new Error("Route insert failed");
  return routeView(env, row);
}

async function forwardTarget(env: Env, target: string): Promise<string> {
  const rcpt = target.trim().toLowerCase();
  if (!rcpt.includes("@") || rcpt.startsWith("@") || rcpt.endsWith("@")) {
    throw new Error("forward target must be an email address");
  }
  const domains = await allDomains(env);
  if (domains.some((domain) => rcpt.endsWith(`@${domain}`))) {
    throw new Error("forward target must be outside the BotMail domains");
  }
  return rcpt;
}

export async function updateRoute(
  env: Env,
  id: string,
  patch: { enabled?: boolean; target?: string; targets?: string[] },
): Promise<RouteView> {
  const current = await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first<RouteRow>();
  if (!current) throw new Error("Route not found");
  if (current.deleted_at) throw new Error("Route is archived. Restore it first.");
  const enabled = patch.enabled === undefined ? current.enabled : patch.enabled ? 1 : 0;
  let target = current.target;
  let aliasTargets: string[] | null = null;
  if (current.kind === "alias" && (patch.targets !== undefined || patch.target !== undefined)) {
    aliasTargets = await resolveAliasTargets(env, patch.targets ?? [patch.target ?? ""]);
    target = aliasTargets[0] ?? current.target;
  } else if (patch.target !== undefined && current.kind === "forward") {
    target = await forwardTarget(env, patch.target);
  }
  const stamp = nowIso();
  const statements = [
    env.DB.prepare(`UPDATE routes SET target = ?, enabled = ?, updated_at = ? WHERE id = ?`).bind(target, enabled, stamp, id),
  ];
  if (aliasTargets) {
    const placeholders = aliasTargets.map(() => "?").join(", ");
    statements.push(
      env.DB.prepare(
        `UPDATE alias_targets SET removed_at = ?
          WHERE route_id = ? AND removed_at IS NULL AND bot_id NOT IN (${placeholders})`,
      ).bind(stamp, id, ...aliasTargets),
    );
    for (const botId of aliasTargets) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO alias_targets (route_id, bot_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(route_id, bot_id) DO UPDATE SET removed_at = NULL`,
        ).bind(id, botId, stamp),
      );
    }
  }
  await env.DB.batch(statements);
  const row = await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first<RouteRow>();
  if (!row) throw new Error("Route not found");
  return routeView(env, row);
}

export async function deleteRoute(env: Env, id: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT id, deleted_at FROM routes WHERE id = ?`).bind(id).first<{ id: string; deleted_at: string | null }>();
  if (!existing) throw new Error("Route not found");
  if (existing.deleted_at) return;
  const stamp = nowIso();
  await env.DB.prepare(`UPDATE routes SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ?`).bind(stamp, stamp, id).run();
}

export async function restoreRoute(env: Env, id: string): Promise<RouteView> {
  const current = await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first<RouteRow>();
  if (!current) throw new Error("Route not found");
  if (!current.deleted_at) return routeView(env, current);
  const domain = await getDomainRow(env, current.domain);
  if (domain?.deleted_at) throw new HttpError(`Restore ${current.domain} before restoring this rule.`, 409, "domain_archived");
  await env.DB.prepare(`UPDATE routes SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?`).bind(nowIso(), id).run();
  const row = await env.DB.prepare(`SELECT ${ROUTE_COLUMNS} FROM routes WHERE id = ?`).bind(id).first<RouteRow>();
  if (!row) throw new Error("Route not found");
  return routeView(env, row);
}

/** Addresses this mailbox may use as From: its own address, plus aliases that deliver to it. */
export async function addressesForSender(env: Env, bot: BotRow): Promise<Set<string>> {
  const own = botMailbox(env, bot).toLowerCase();
  const set = new Set<string>([own]);
  const rows = await env.DB.prepare(
    `SELECT r.local_part, r.domain FROM routes r
       JOIN alias_targets t ON t.route_id = r.id
      WHERE t.bot_id = ? AND t.removed_at IS NULL AND r.kind = 'alias' AND r.enabled = 1 AND r.deleted_at IS NULL`,
  )
    .bind(bot.id)
    .all<{ local_part: string; domain: string }>();
  for (const row of rows.results) set.add(addressKey(row.local_part, row.domain));
  // Any alias_targets row, removed or not, means this is not a pre-0020 alias.
  // routes.target must not bring a dropped mailbox back.
  const legacy = await env.DB.prepare(
    `SELECT local_part, domain FROM routes
      WHERE kind = 'alias' AND target = ? AND enabled = 1 AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM alias_targets t WHERE t.route_id = routes.id AND t.removed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM alias_targets t WHERE t.route_id = routes.id AND t.removed_at IS NOT NULL)`,
  )
    .bind(bot.id)
    .all<{ local_part: string; domain: string }>();
  for (const row of legacy.results) set.add(addressKey(row.local_part, row.domain));
  return set;
}

export async function resolveSendFrom(env: Env, bot: BotRow, requested?: string): Promise<string> {
  const own = botMailbox(env, bot);
  if (!requested?.trim()) return own;
  const parsed = parseMailbox(requested);
  if (!parsed) throw new Error("from must be an email address");
  if (parsed.address === own.toLowerCase()) return own;
  const allowed = await addressesForSender(env, bot);
  if (allowed.has(parsed.address)) return parsed.address;
  const alias = await env.DB.prepare(
    `SELECT id FROM routes WHERE local_part = ? AND domain = ? AND kind = 'alias' AND enabled = 1 AND deleted_at IS NULL`,
  )
    .bind(parsed.local, parsed.domain)
    .first<{ id: string }>();
  if (alias) throw new Error(`Cannot send from ${parsed.address}. That alias does not deliver to this mailbox.`);
  throw new Error(`Cannot send from ${parsed.address}. It is not an alias for this mailbox.`);
}

async function readSetting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? "";
}
