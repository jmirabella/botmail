import { mailDomain } from "./address";
import { syncAddressRegistry } from "./address-registry";
import { HttpError } from "./errors";
import { logError, logInfo } from "./log";
import { UNROUTED_BOT_ID } from "./seed-bots";

const API = "https://api.cloudflare.com/client/v4";

export type CheckState = "ok" | "error" | "pending" | "manual" | "skipped";
export type CheckGroup = "routing" | "sending" | "dns";

export type DomainCheck = {
  id: string;
  group: CheckGroup;
  label: string;
  state: CheckState;
  detail: string;
};

type StoredStatus = {
  mode?: "api" | "manual";
  checks?: DomainCheck[];
  error?: string | null;
};

export type DomainRow = {
  domain: string;
  is_default: number;
  enabled: number;
  zone_id: string | null;
  zone_name: string | null;
  status: string;
  checked_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DomainView = {
  domain: string;
  is_default: boolean;
  enabled: boolean;
  zone_id: string | null;
  zone_name: string | null;
  bot_count: number;
  mode: "api" | "manual";
  routing: CheckState;
  sending: CheckState;
  dns: CheckState;
  checks: DomainCheck[];
  error: string | null;
  manual_steps: string[];
  dns_commands: string;
  checked_at: string | null;
  deleted_at: string | null;
  archived: boolean;
  created_at: string;
};

const DOMAIN_COLUMNS = "domain, is_default, enabled, zone_id, zone_name, status, checked_at, deleted_at, created_at, updated_at";
const DOMAIN_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

let domainFetch: typeof fetch | null = null;

/** Tests and the local preview replace the Cloudflare API and DNS-over-HTTPS calls. */
export function setDomainFetch(next: typeof fetch | null): void {
  domainFetch = next;
}

function activeFetch(): typeof fetch {
  return domainFetch ?? fetch;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeDomain(input: string): string {
  const domain = String(input ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (!DOMAIN_NAME.test(domain)) {
    throw new HttpError("Enter a DNS name such as bots.example.com", 400, "invalid_domain");
  }
  return domain;
}

export function configuredDomain(env: Env): string | null {
  try {
    return mailDomain(env);
  } catch {
    return null;
  }
}

function apiToken(env: Env): string {
  return String(env.CF_API_TOKEN ?? "").trim();
}

function accountId(env: Env): string {
  return String(env.CF_ACCOUNT_ID ?? "").trim();
}

/** The Worker can call the Cloudflare API only with both a CF_API_TOKEN secret and the CF_ACCOUNT_ID var. */
export function apiConfigured(env: Env): boolean {
  return Boolean(apiToken(env) && accountId(env));
}

function workerName(env: Env): string {
  return String(env.WORKER_NAME ?? "").trim();
}

/**
 * Migration 0004 leaves domain '' on rows that existed before it. D1 cannot read MAIL_DOMAIN,
 * so every entry point runs this: one read when nothing is pending, one batch when something is.
 */
export async function ensureDomains(env: Env): Promise<void> {
  const fallback = configuredDomain(env);
  if (!fallback) return;
  const state = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bots WHERE domain = '') AS bots_pending,
            (SELECT COUNT(*) FROM routes WHERE domain = '') AS routes_pending,
            (SELECT COUNT(*) FROM mail_domains WHERE domain = ? AND is_default = 1 AND enabled = 1) AS seeded,
            (SELECT COUNT(*) FROM mail_domains WHERE is_default = 1) AS defaults`,
  )
    .bind(fallback)
    .first<{ bots_pending: number; routes_pending: number; seeded: number; defaults: number }>();
  if (state && !state.bots_pending && !state.routes_pending && state.seeded === 1 && state.defaults === 1) {
    await syncAddressRegistry(env);
    return;
  }
  const stamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE mail_domains SET is_default = 0, updated_at = ? WHERE is_default = 1 AND domain != ?`).bind(stamp, fallback),
    env.DB.prepare(
      `INSERT INTO mail_domains (domain, is_default, enabled, status, created_at, updated_at)
       VALUES (?, 1, 1, '{}', ?, ?)
       ON CONFLICT(domain) DO UPDATE SET is_default = 1, enabled = 1, updated_at = excluded.updated_at`,
    ).bind(fallback, stamp, stamp),
    // OR IGNORE: a half-finished earlier setup could leave the same address on both '' and the default.
    env.DB.prepare(`UPDATE OR IGNORE bots SET domain = ? WHERE domain = ''`).bind(fallback),
    env.DB.prepare(`UPDATE OR IGNORE routes SET domain = ? WHERE domain = ''`).bind(fallback),
  ]);
  logInfo("domains_backfilled", { domain: fallback, bots: state?.bots_pending ?? 0, routes: state?.routes_pending ?? 0 });
  await syncAddressRegistry(env);
}

export async function getDomainRow(env: Env, domain: string): Promise<DomainRow | null> {
  return env.DB.prepare(`SELECT ${DOMAIN_COLUMNS} FROM mail_domains WHERE domain = ?`).bind(domain).first<DomainRow>();
}

export async function defaultDomain(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT domain FROM mail_domains WHERE is_default = 1 LIMIT 1`).first<{ domain: string }>();
  const domain = row?.domain || configuredDomain(env);
  if (!domain) throw new HttpError("MAIL_DOMAIN is not configured", 500, "mail_domain_missing");
  return domain;
}

export async function enabledDomains(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT domain FROM mail_domains WHERE enabled = 1 AND deleted_at IS NULL ORDER BY is_default DESC, domain`).all<{ domain: string }>();
  const domains = rows.results.map((row) => row.domain);
  const fallback = configuredDomain(env);
  if (fallback && !domains.includes(fallback)) domains.unshift(fallback);
  return domains;
}

/** Every domain BotMail answers for, enabled or not, so forwards never loop back into it. */
export async function allDomains(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(`SELECT domain FROM mail_domains`).all<{ domain: string }>();
  const domains = new Set(rows.results.map((row) => row.domain));
  const fallback = configuredDomain(env);
  if (fallback) domains.add(fallback);
  return [...domains];
}

export async function requireEnabledDomain(env: Env, input: string | undefined): Promise<string> {
  if (!input?.trim()) return defaultDomain(env);
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError(`${domain} is not a BotMail domain. Add it on the Domains page first.`, 400, "unknown_domain");
  if (row.deleted_at) throw new HttpError(`${domain} is archived. Restore it on the Domains page.`, 400, "domain_archived");
  if (row.enabled !== 1) throw new HttpError(`${domain} is disabled`, 400, "domain_disabled");
  return domain;
}

async function botCounts(env: Env): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(`SELECT domain, COUNT(*) AS n FROM bots WHERE id != ? AND deleted_at IS NULL GROUP BY domain`)
    .bind(UNROUTED_BOT_ID)
    .all<{ domain: string; n: number }>();
  return new Map(rows.results.map((row) => [row.domain, Number(row.n) || 0]));
}

export async function listDomains(env: Env, includeArchived = false): Promise<DomainView[]> {
  const rows = await env.DB.prepare(
    `SELECT ${DOMAIN_COLUMNS} FROM mail_domains WHERE (? = 1 OR deleted_at IS NULL) ORDER BY is_default DESC, domain`,
  )
    .bind(includeArchived ? 1 : 0)
    .all<DomainRow>();
  const counts = await botCounts(env);
  return rows.results.map((row) => domainView(env, row, counts.get(row.domain) ?? 0));
}

export async function getDomain(env: Env, input: string): Promise<DomainView> {
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError("Domain not found", 404, "not_found");
  const counts = await botCounts(env);
  return domainView(env, row, counts.get(domain) ?? 0);
}

function readStatus(text: string): StoredStatus {
  try {
    const parsed = JSON.parse(text || "{}") as StoredStatus;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function rollup(checks: DomainCheck[]): CheckState {
  if (checks.length === 0) return "pending";
  if (checks.some((check) => check.state === "error")) return "error";
  if (checks.some((check) => check.state === "pending")) return "pending";
  if (checks.some((check) => check.state === "manual")) return "manual";
  return "ok";
}

export function summarizeChecks(mode: "api" | "manual", checks: DomainCheck[]): Record<CheckGroup, CheckState> {
  const dns = checks.filter((check) => check.group === "dns");
  const byId = (ids: string[]) => dns.filter((check) => ids.includes(check.id));
  if (mode === "manual") {
    // Without the API the records are the only evidence. A missing record still needs the manual step.
    const routingDns = byId(["dns_mx"]);
    const sendingDns = byId(["dns_return", "dns_spf", "dns_dkim"]);
    const fromDns = (items: DomainCheck[]): CheckState => {
      const state = rollup(items);
      return state === "error" ? "manual" : state;
    };
    return { routing: fromDns(routingDns), sending: fromDns(sendingDns), dns: rollup(dns) };
  }
  return {
    routing: rollup(checks.filter((check) => check.group === "routing")),
    sending: rollup(checks.filter((check) => check.group === "sending")),
    dns: rollup(dns),
  };
}

export function domainView(env: Env, row: DomainRow, botCount: number): DomainView {
  const stored = readStatus(row.status);
  const mode = stored.mode ?? (apiConfigured(env) ? "api" : "manual");
  const checks = Array.isArray(stored.checks) ? stored.checks : [];
  const summary = summarizeChecks(mode, checks);
  const zone = row.zone_name || guessZone(row.domain);
  return {
    domain: row.domain,
    is_default: row.is_default === 1,
    enabled: row.enabled === 1,
    zone_id: row.zone_id,
    zone_name: row.zone_name,
    bot_count: botCount,
    mode,
    ...summary,
    checks,
    error: stored.error ?? null,
    manual_steps: manualSteps(env, row.domain, zone),
    dns_commands: dnsCommands(row.domain),
    checked_at: row.checked_at,
    deleted_at: row.deleted_at,
    archived: Boolean(row.deleted_at),
    created_at: row.created_at,
  };
}

function guessZone(domain: string): string {
  return domain.split(".").slice(-2).join(".");
}

export function manualSteps(env: Env, domain: string, zone: string): string[] {
  const worker = workerName(env) || "this Worker";
  const label = domain === zone ? "" : domain.slice(0, -(zone.length + 1));
  const steps = [
    `Cloudflare dashboard → ${zone} → Email → Email Routing: enable Email Routing, then Settings → turn on subaddressing.`,
  ];
  if (label) {
    steps.push(`Email Routing → Settings → Subdomains → add "${label}" so the MX and SPF records exist on ${domain}.`);
  }
  if (String(env.ROUTING_MODE || "") === "literal") {
    steps.push(
      `This Worker uses literal routing. Leave the *@${zone} catch-all on its current Worker. Add one routing rule per mailbox instead.`,
    );
  } else {
    steps.push(
      `Email Routing → Routing rules → Catch-all address → Send to a Worker → ${worker}. One catch-all covers every address in ${zone}.`,
    );
  }
  steps.push(
    `Email Sending → Onboard Domain → ${domain}. That writes the cf-bounce MX, SPF, DKIM, and _dmarc records.`,
    "Come back here and press Recheck. To let BotMail do these steps, store CF_API_TOKEN as a Worker secret (see the README).",
  );
  return steps;
}

export function dnsCommands(domain: string): string {
  return [
    `dig +short MX ${domain}`,
    `dig +short MX cf-bounce.${domain}`,
    `dig +short TXT cf-bounce.${domain}`,
    `dig +short TXT cf-bounce._domainkey.${domain}`,
    `dig +short TXT _dmarc.${domain}`,
  ].join("\n");
}

type CfResponse<T> = { ok: boolean; status: number; result: T | null; errors: string[] };

async function cf<T>(env: Env, method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
  try {
    const response = await activeFetch()(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiToken(env)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    let parsed: { success?: boolean; result?: T; errors?: Array<{ code?: number; message?: string }> } = {};
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      parsed = {};
    }
    const errors = (parsed.errors ?? []).map((error) => error.message || `error ${error.code ?? ""}`.trim()).filter(Boolean);
    return {
      ok: response.ok && parsed.success !== false,
      status: response.status,
      result: parsed.result ?? null,
      errors: errors.length ? errors : response.ok ? [] : [`HTTP ${response.status}`],
    };
  } catch (error) {
    return { ok: false, status: 0, result: null, errors: [error instanceof Error ? error.message : "request failed"] };
  }
}

function cfError(response: CfResponse<unknown>): string {
  const text = response.errors.join("; ") || `HTTP ${response.status}`;
  return response.status === 403 ? `${text} (the token is missing a permission)` : text;
}

type Zone = { id: string; name: string; account?: { id?: string } };

/** The longest zone in this account that contains the domain. Zones on other accounts never match. */
export async function findZone(env: Env, domain: string): Promise<Zone | null> {
  const account = accountId(env);
  const labels = domain.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const name = labels.slice(index).join(".");
    const found = await cf<Zone[]>(env, "GET", `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(account)}&per_page=5`);
    if (!found.ok) throw new HttpError(`Cloudflare API: ${cfError(found)}`, 502, "cf_api");
    const zone = (found.result ?? []).find((item) => item.name === name && item.account?.id === account);
    if (zone) return zone;
  }
  return null;
}

function check(id: string, group: CheckGroup, label: string, state: CheckState, detail: string): DomainCheck {
  return { id, group, label, state, detail };
}

async function provisionChecks(env: Env, domain: string, zone: Zone, write: boolean): Promise<DomainCheck[]> {
  const checks: DomainCheck[] = [];
  const base = `/zones/${zone.id}/email/routing`;

  const routing = await cf<{ enabled?: boolean; support_subaddress?: boolean }>(env, "GET", base);
  if (routing.ok && routing.result?.enabled) {
    checks.push(check("routing", "routing", `Email Routing on ${zone.name}`, "ok", "Enabled"));
  } else if (!write) {
    checks.push(check("routing", "routing", `Email Routing on ${zone.name}`, "error", routing.ok ? "Not enabled" : cfError(routing)));
  } else {
    const enabled = await cf(env, "POST", `${base}/enable`, {});
    checks.push(
      check("routing", "routing", `Email Routing on ${zone.name}`, enabled.ok ? "ok" : "error", enabled.ok ? "Enabled just now" : cfError(enabled)),
    );
  }
  if (write && routing.result?.support_subaddress !== true) {
    await cf(env, "PATCH", base, { support_subaddress: true });
  }

  if (domain !== zone.name) {
    if (write) {
      const dns = await cf(env, "POST", `${base}/dns`, { name: domain });
      const already = !dns.ok && /already|exist/i.test(dns.errors.join(" "));
      checks.push(
        check(
          "routing_dns",
          "routing",
          `Routing records for ${domain}`,
          dns.ok || already ? "ok" : "error",
          dns.ok ? "Requested MX and SPF" : already ? "Already present" : cfError(dns),
        ),
      );
    } else {
      checks.push(check("routing_dns", "routing", `Routing records for ${domain}`, "pending", "Verified by the MX lookup below"));
    }
  }

  const worker = workerName(env);
  const label = `Catch-all *@${zone.name} → ${worker || "Worker"}`;
  if (String(env.ROUTING_MODE || "") === "literal") {
    checks.push(check("catch_all", "routing", `Catch-all *@${zone.name}`, "ok", "Literal routing leaves the zone catch-all unchanged"));
  } else if (!worker) {
    checks.push(check("catch_all", "routing", label, "manual", "WORKER_NAME is not set; check the catch-all by hand"));
  } else {
    const rule = await cf<{ enabled?: boolean; actions?: Array<{ type?: string; value?: string[] }> }>(env, "GET", `${base}/rules/catch_all`);
    const action = rule.result?.actions?.[0];
    const targets = Array.isArray(action?.value) ? action.value : [];
    if (!rule.ok) {
      checks.push(check("catch_all", "routing", label, "error", cfError(rule)));
    } else if (rule.result?.enabled && action?.type === "worker" && targets.includes(worker)) {
      checks.push(check("catch_all", "routing", label, "ok", "Sends to this Worker"));
    } else if (rule.result?.enabled && action?.type !== "drop") {
      checks.push(
        check("catch_all", "routing", label, "error", `The catch-all already sends to ${targets.join(", ") || action?.type || "another target"}. BotMail does not overwrite it.`),
      );
    } else if (!write) {
      checks.push(check("catch_all", "routing", label, "error", "Disabled"));
    } else {
      const put = await cf(env, "PUT", `${base}/rules/catch_all`, {
        enabled: true,
        name: `${worker} catch-all`,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [worker] }],
      });
      checks.push(check("catch_all", "routing", label, put.ok ? "ok" : "error", put.ok ? "Pointed at this Worker" : cfError(put)));
    }
  }

  const sendingLabel = `Email Sending for ${domain}`;
  const listed = await cf<Array<{ name?: string; enabled?: boolean }>>(env, "GET", `/zones/${zone.id}/email/sending/subdomains`);
  const present = (listed.result ?? []).find((row) => row.name === domain);
  if (present && present.enabled !== false) {
    checks.push(check("sending", "sending", sendingLabel, "ok", "Onboarded"));
  } else if (!listed.ok) {
    checks.push(check("sending", "sending", sendingLabel, "error", cfError(listed)));
  } else if (!write) {
    checks.push(check("sending", "sending", sendingLabel, "error", "Not onboarded"));
  } else {
    const created = await cf(env, "POST", `/zones/${zone.id}/email/sending/subdomains`, { name: domain });
    checks.push(check("sending", "sending", sendingLabel, created.ok ? "ok" : "error", created.ok ? "Onboarded just now" : cfError(created)));
  }
  return checks;
}

function manualChecks(zone: string): DomainCheck[] {
  return [
    check("routing", "routing", `Email Routing on ${zone}`, "manual", "No CF_API_TOKEN; follow the steps below"),
    check("catch_all", "routing", `Catch-all *@${zone}`, "manual", "Confirm it sends to this Worker"),
    check("sending", "sending", "Email Sending", "manual", "Onboard the domain in Email Sending"),
  ];
}

type DnsAnswer = { data?: string };

async function doh(name: string, type: string): Promise<DnsAnswer[]> {
  const response = await activeFetch()(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) },
  );
  if (!response.ok) throw new Error(`DNS HTTP ${response.status}`);
  const body = (await response.json()) as { Answer?: DnsAnswer[] };
  return body.Answer ?? [];
}

function answers(rows: DnsAnswer[]): string {
  return rows.map((row) => String(row.data ?? "").replaceAll('"', "")).join(" ").trim();
}

export async function dnsChecks(domain: string): Promise<DomainCheck[]> {
  const lookups: Array<{
    id: string;
    label: string;
    name: string;
    type: string;
    test: (text: string, rows: DnsAnswer[]) => boolean;
    missing: string;
  }> = [
    {
      id: "dns_mx",
      label: `MX ${domain}`,
      name: domain,
      type: "MX",
      test: (text) => /mx\.cloudflare\.net/i.test(text),
      missing: "No Email Routing MX (route*.mx.cloudflare.net)",
    },
    {
      id: "dns_return",
      label: `MX cf-bounce.${domain}`,
      name: `cf-bounce.${domain}`,
      type: "MX",
      test: (_text, rows) => rows.length > 0,
      missing: "No return-path MX",
    },
    {
      id: "dns_spf",
      label: `SPF cf-bounce.${domain}`,
      name: `cf-bounce.${domain}`,
      type: "TXT",
      test: (text) => /v=spf1/i.test(text),
      missing: "No SPF record",
    },
    {
      id: "dns_dkim",
      label: `DKIM cf-bounce._domainkey.${domain}`,
      name: `cf-bounce._domainkey.${domain}`,
      type: "TXT",
      test: (_text, rows) => rows.length > 0,
      missing: "No DKIM key",
    },
    {
      id: "dns_dmarc",
      label: `DMARC _dmarc.${domain}`,
      name: `_dmarc.${domain}`,
      type: "TXT",
      test: (text) => /v=dmarc1/i.test(text),
      missing: "No DMARC policy",
    },
  ];
  return Promise.all(
    lookups.map(async (lookup) => {
      try {
        const rows = await doh(lookup.name, lookup.type);
        const text = answers(rows);
        const passed = lookup.test(text, rows);
        return check(lookup.id, "dns", lookup.label, passed ? "ok" : "error", passed ? text.slice(0, 160) : lookup.missing);
      } catch (error) {
        return check(lookup.id, "dns", lookup.label, "pending", `Lookup failed: ${error instanceof Error ? error.message : "DNS"}`);
      }
    }),
  );
}

/**
 * Re-run every check for a domain and store the result. With `repair`, missing routing, catch-all,
 * and sending pieces are created; existing rules that point somewhere else are reported, never replaced.
 */
export async function checkDomain(env: Env, input: string, repair = true): Promise<DomainView> {
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError("Domain not found", 404, "not_found");
  const write = repair && row.enabled === 1 && !row.deleted_at;
  let mode: "api" | "manual" = "manual";
  let checks: DomainCheck[] = [];
  let error: string | null = null;
  let zoneId = row.zone_id;
  let zoneName = row.zone_name;
  if (apiConfigured(env)) {
    mode = "api";
    try {
      const zone = zoneId && zoneName ? { id: zoneId, name: zoneName } : await findZone(env, domain);
      if (!zone) {
        error = `No zone for ${domain} in this Cloudflare account`;
      } else {
        zoneId = zone.id;
        zoneName = zone.name;
        checks = await provisionChecks(env, domain, zone, write);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : "Cloudflare API failed";
    }
  } else {
    checks = manualChecks(zoneName || guessZone(domain));
  }
  const records = await dnsChecks(domain);
  const mx = records.find((item) => item.id === "dns_mx");
  for (const item of checks) {
    if (item.id === "routing_dns" && mx?.state === "ok") {
      item.state = "ok";
      if (item.detail.startsWith("Verified")) item.detail = "MX present";
    }
  }
  checks.push(...records);
  const stamp = nowIso();
  await env.DB.prepare(`UPDATE mail_domains SET zone_id = ?, zone_name = ?, status = ?, checked_at = ?, updated_at = ? WHERE domain = ?`)
    .bind(zoneId, zoneName, JSON.stringify({ mode, checks, error } satisfies StoredStatus), stamp, stamp, domain)
    .run();
  if (error) logError("domain_check_failed", { domain, error });
  else logInfo("domain_checked", { domain, mode });
  return getDomain(env, domain);
}

export async function addDomain(env: Env, input: string): Promise<DomainView> {
  const domain = normalizeDomain(input);
  const existing = await getDomainRow(env, domain);
  if (existing?.deleted_at) throw new HttpError(`${domain} is archived. Restore it?`, 409, "archived");
  if (existing) throw new HttpError(`${domain} is already a mail domain`, 409, "domain_exists");
  let zone: Zone | null = null;
  if (apiConfigured(env)) {
    zone = await findZone(env, domain);
    if (!zone) {
      throw new HttpError(
        `No zone for ${domain} in this Cloudflare account. BotMail only adds domains on zones the account owns.`,
        400,
        "zone_not_found",
      );
    }
  }
  const stamp = nowIso();
  await env.DB.prepare(
    `INSERT INTO mail_domains (domain, is_default, enabled, zone_id, zone_name, status, created_at, updated_at)
     VALUES (?, 0, 1, ?, ?, '{}', ?, ?)`,
  )
    .bind(domain, zone?.id ?? null, zone?.name ?? null, stamp, stamp)
    .run();
  logInfo("domain_added", { domain, zone: zone?.name ?? null });
  return checkDomain(env, domain, true);
}

export async function setDomainEnabled(env: Env, input: string, enabled: boolean): Promise<DomainView> {
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError("Domain not found", 404, "not_found");
  if (row.deleted_at) throw new HttpError(`${domain} is archived. Restore it on the Domains page.`, 400, "domain_archived");
  if (!enabled && row.is_default === 1) {
    throw new HttpError("The default domain comes from mailDomain in the config and cannot be disabled", 400, "default_domain");
  }
  await env.DB.prepare(`UPDATE mail_domains SET enabled = ?, updated_at = ? WHERE domain = ?`)
    .bind(enabled ? 1 : 0, nowIso(), domain)
    .run();
  return getDomain(env, domain);
}

export async function deleteDomain(env: Env, input: string): Promise<void> {
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError("Domain not found", 404, "not_found");
  if (row.is_default === 1) throw new HttpError("The default domain cannot be archived", 400, "default_domain");
  if (row.deleted_at) return;
  const stamp = nowIso();
  await env.DB.prepare(`UPDATE mail_domains SET deleted_at = ?, enabled = 0, updated_at = ? WHERE domain = ?`).bind(stamp, stamp, domain).run();
}

export async function restoreDomain(env: Env, input: string): Promise<DomainView> {
  const domain = normalizeDomain(input);
  const row = await getDomainRow(env, domain);
  if (!row) throw new HttpError("Domain not found", 404, "not_found");
  if (!row.deleted_at) return getDomain(env, domain);
  await env.DB.prepare(`UPDATE mail_domains SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE domain = ?`).bind(nowIso(), domain).run();
  return getDomain(env, domain);
}
