import { AuthorizationError, OAuthError, OAuthProvider, type GrantSummary } from "@cloudflare/workers-oauth-provider";
import { botMailbox } from "./address";
import { accessIdentity, authenticate, bearerToken, verifiedOwnerEmail, type Session } from "./auth";
import { sha256Hex } from "./crypto";
import { createBot, getBot, listConnectableBots, nowIso, type BotRow } from "./db";
import { accessRequired, handleHttp, isAdminHost } from "./http";
import { logError } from "./log";
import { handleMcp } from "./mcp";
import { UNROUTED_BOT_ID } from "./seed-bots";
import { escapeHtml } from "./text";

export type MailboxProps = { kind: "admin" } | { kind: "bot"; botId: string };

export type MailboxConnector = {
  grant_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
};

const providers = new Map<string, OAuthProvider<Env>>();

export function mcpResource(env: Env): string {
  const host = String(env.PUBLIC_HOST || "").trim().toLowerCase();
  return host ? `https://${host}/mcp` : "";
}

export function oauthProvider(env: Env): OAuthProvider<Env> {
  const origin = mcpResource(env).replace(/\/mcp$/, "");
  if (!origin) throw new Error("PUBLIC_HOST is required for MCP OAuth");
  const cached = providers.get(origin);
  if (cached) return cached;
  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["mailbox", "offline_access"],
    requiredScopes: ["mailbox"],
    // Explicit undefined: the library's default is 30 days, and a spread of undefined overwrites it.
    refreshTokenTTL: undefined,
    clientRegistrationTTL: undefined,
    allowPrivateUseRedirectUris: true,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "BotMail",
    },
    resolveExternalToken,
    tokenExchangeCallback: (options) => enforceSingleConnection(options),
    onError() {},
  });
  providers.set(origin, provider);
  return provider;
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const session = await sessionFromProps(env, (ctx as ExecutionContext & { props?: MailboxProps }).props);
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (session.kind === "bot" && !(await liveCredential(env, request, session.bot))) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.kind === "bot") await recordGrantUse(env, ctx, session.bot.id);
    return handleMcp(request, env, ctx, session);
  },
};

/** A static mailbox key matches the hash. An OAuth grant is allowed only while its connection row is current and not revoked. */
async function liveCredential(env: Env, request: Request, bot: BotRow): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  if (bot.api_key_hash && (await sha256Hex(token)) === bot.api_key_hash) return true;
  try {
    const summary = await env.OAUTH_PROVIDER.unwrapToken(token);
    if (!summary?.grantId) return false;
    const row = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = ?`)
      .bind(bot.id)
      .first<{ grant_id: string; revoked_at: string | null }>();
    return Boolean(row && !row.revoked_at && row.grant_id === summary.grantId);
  } catch {
    return false;
  }
}

/** Revoke every KV grant for this mailbox. The D1 row is marked, not deleted, by the caller. */
export async function revokeBotGrants(env: Env, botId: string): Promise<void> {
  const summaries = await listUserGrantSummaries(env, botId);
  for (const summary of summaries) {
    await env.OAUTH_PROVIDER.revokeGrant(summary.id, botId);
  }
}

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/oauth/authorize") return handleAuthorize(request, env);
    return handleHttp(request, env);
  },
};

async function resolveExternalToken(input: {
  token: string;
  request: Request;
  env: Env;
}): Promise<{ props: MailboxProps; audience: string } | null> {
  const audience = mcpResource(input.env);
  if (!audience) return null;
  const session = await authenticate(new Request(input.request.url, { headers: { authorization: `Bearer ${input.token}` } }), input.env);
  if (!session) return null;
  if (session.kind === "admin") return { props: { kind: "admin" }, audience };
  return { props: { kind: "bot", botId: session.bot.id }, audience };
}

async function sessionFromProps(env: Env, props: MailboxProps | undefined): Promise<Session | null> {
  if (!props || (props.kind !== "admin" && props.kind !== "bot")) return null;
  if (props.kind === "admin") return { kind: "admin" };
  if (!props.botId || props.botId === UNROUTED_BOT_ID) return null;
  const bot = await getBot(env, props.botId);
  if (!bot || bot.deleted_at || bot.enabled !== 1) return null;
  return { kind: "bot", bot };
}

async function recordGrantUse(env: Env, ctx: ExecutionContext, botId: string): Promise<void> {
  const auth = (ctx as ExecutionContext & { auth?: { token?: string; clientId?: string } }).auth;
  if (!auth?.clientId || !auth.token) return;
  try {
    const summary = await env.OAUTH_PROVIDER.unwrapToken(auth.token);
    if (!summary?.grantId) return;
    await env.DB.prepare(
      `INSERT INTO oauth_grant_use (grant_id, bot_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET bot_id = excluded.bot_id, last_used_at = excluded.last_used_at`,
    )
      .bind(summary.grantId, botId, nowIso())
      .run();
  } catch (error) {
    logError("oauth_grant_use_failed", { error: error instanceof Error ? error.message : "grant use failed", botId });
  }
}

export async function listMailboxConnectors(env: Env, botId: string): Promise<MailboxConnector[]> {
  const summaries = await listUserGrantSummaries(env, botId);
  const grants: GrantSummary[] = [];
  for (const summary of summaries) {
    if ((await grantState(env, botId, summary.id)) === "active") grants.push(summary);
  }
  const uses = await env.DB.prepare(`SELECT grant_id, last_used_at FROM oauth_grant_use WHERE bot_id = ?`)
    .bind(botId)
    .all<{ grant_id: string; last_used_at: string }>();
  const lastUsed = new Map(uses.results.map((row) => [row.grant_id, row.last_used_at]));
  return grants
    .map((grant) => ({
      grant_id: grant.id,
      client_name: clientNameOf(grant),
      created_at: new Date(grant.createdAt * 1000).toISOString(),
      last_used_at: lastUsed.get(grant.id) ?? null,
    }))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function revokeMailboxConnector(env: Env, botId: string, grantId: string): Promise<void> {
  await env.OAUTH_PROVIDER.revokeGrant(grantId, botId);
  // Match grant_id so a connection claimed while this revoke was in flight stays put.
  // The row stays. Reconnect updates it.
  const stamp = nowIso();
  await env.DB.prepare(
    `UPDATE oauth_connection SET revoked_at = ?, last_revoked_at = ? WHERE bot_id = ? AND grant_id = ? AND revoked_at IS NULL`,
  )
    .bind(stamp, stamp, botId, grantId)
    .run();
}

function clientNameOf(grant: GrantSummary): string {
  const meta = grant.metadata as { clientName?: unknown } | null;
  if (meta && typeof meta.clientName === "string" && meta.clientName.trim()) return meta.clientName.trim();
  return grant.clientId;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!isAdminHost(url, env)) {
    const admin = String(env.ADMIN_HOST || "").trim().toLowerCase();
    if (!admin) {
      return new Response("Cloudflare Access admin host is not configured, so a connector cannot be approved.", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return Response.redirect(new URL(`/oauth/authorize${url.search}`, `https://${admin}`).toString(), 302);
  }
  const identity = await accessIdentity(request, env);
  if (!identity) return accessRequired(env, url);
  if (request.method !== "GET" && request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });

  try {
    const oauth = env.OAUTH_PROVIDER;
    const authRequest = await oauth.parseAuthRequest(publicAuthorizeRequest(request, env));
    const details = await oauth.describeConsent(authRequest);
    if (request.method === "GET") {
      const consent = await oauth.beginConsent(authRequest);
      const bots = await listAvailableMailboxes(env);
      return consentPage(env, details, consent.handle, bots, "", consent.headers);
    }

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return continueToClient(denied.redirectTo, denied.headers, "Declined. Sending you back to the bot.");
    }
    let bot: BotRow;
    try {
      bot = await chosenBot(env, form, await verifiedOwnerEmail(request, env));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Choose a mailbox";
      return consentPage(env, details, handle, await listAvailableMailboxes(env), message, undefined, draftFrom(form));
    }
    const approved = await oauth.approveConsent(request, handle, { scope: ["mailbox"] });
    const issuedAtMs = Date.now();
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: bot.id,
      metadata: { clientName: details.clientName, email: identity.email },
      scope: approved.request.scope,
      props: { kind: "bot", botId: bot.id } satisfies MailboxProps,
    });
    await stampGrantIssuedAt(env, bot.id, redirectTo, issuedAtMs);
    // A 302 to the client's redirect_uri is a form navigation. Chrome applies the consent
    // page's form-action 'self' to that redirect and drops it, so the code never arrives.
    return continueToClient(redirectTo, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return plainPage(escapeHtml(error.description), 400);
    logError("oauth_authorize_failed", { error: error instanceof Error ? error.message : "authorize failed" });
    return plainPage("This connector could not be approved. Start Connect again from the bot.", 500);
  }
}

const ALREADY_CONNECTED = "That mailbox is already connected to a bot. Revoke it on its BotMail page, then connect it again.";

async function chosenBot(env: Env, form: FormData, ownerEmail: string | null): Promise<BotRow> {
  const mode = String(form.get("mode") ?? "");
  const choice = String(form.get("mailbox") ?? "");
  const creating = mode === "new" || (mode !== "existing" && choice === "__new__");
  if (creating) {
    const created = await createBot(env, {
      local: String(form.get("local_part") ?? ""),
      displayName: String(form.get("display_name") ?? ""),
      notes: String(form.get("notes") ?? ""),
      ownerEmail,
    });
    return created.bot;
  }
  const bot = await getBot(env, choice);
  if (!bot || bot.deleted_at || bot.enabled !== 1 || bot.id === UNROUTED_BOT_ID) {
    throw new Error("Choose the mailbox this connector is for.");
  }
  if (await mailboxTaken(env, bot.id)) throw new Error(ALREADY_CONNECTED);
  return bot;
}

async function listUserGrantSummaries(env: Env, botId: string): Promise<GrantSummary[]> {
  const grants: GrantSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(botId, cursor ? { cursor, limit: 100 } : { limit: 100 });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return grants;
}

/** Auth codes are written with a 600s KV TTL. A code that was never exchanged must not hold the mailbox. */
const PENDING_GRANT_SECONDS = 600;

type StoredGrant = {
  createdAt?: number;
  /** Set when this Worker approves the code. Older grants only have createdAt, in whole seconds. */
  issuedAtMs?: number;
  expiresAt?: number;
  authCodeWrappedKey?: string;
};

async function listAvailableMailboxes(env: Env): Promise<BotRow[]> {
  const bots = await listConnectableBots(env);
  const available: BotRow[] = [];
  for (const bot of bots) {
    if (await mailboxTaken(env, bot.id)) continue;
    available.push(bot);
  }
  return available;
}

async function storedGrant(env: Env, botId: string, grantId: string): Promise<StoredGrant | null> {
  return env.OAUTH_KV.get<StoredGrant>(`grant:${botId}:${grantId}`, "json");
}

/** True when the grant was issued at or after revokedAt. Missing issuedAtMs falls back to whole seconds. */
function grantIssuedAtOrAfter(grant: StoredGrant | null, revokedAt: string | null): boolean {
  if (!revokedAt) return true;
  const revokedMs = Date.parse(revokedAt);
  if (!Number.isFinite(revokedMs)) return false;
  if (typeof grant?.issuedAtMs === "number") return grant.issuedAtMs >= revokedMs;
  return (grant?.createdAt ?? 0) >= Math.floor(revokedMs / 1000);
}

/** The library stores createdAt in seconds. Record the approval time in milliseconds on that same grant. */
async function stampGrantIssuedAt(env: Env, botId: string, redirectTo: string, issuedAtMs: number): Promise<void> {
  const code = new URL(redirectTo).searchParams.get("code");
  const [userId, grantId] = code?.split(":") ?? [];
  if (!grantId || userId !== botId) return;
  const key = `grant:${botId}:${grantId}`;
  const current = await env.OAUTH_KV.getWithMetadata<StoredGrant>(key, "json");
  if (!current.value) return;
  const metadata = grantMetadata(current.metadata);
  await env.OAUTH_KV.put(key, JSON.stringify({ ...current.value, issuedAtMs }), {
    expirationTtl: PENDING_GRANT_SECONDS,
    ...(metadata ? { metadata } : {}),
  });
}

function grantMetadata(metadata: unknown): Record<string, string> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

/** Active means the auth code was exchanged. A pending code expires after about 10 minutes. */
async function grantState(env: Env, botId: string, grantId: string): Promise<"active" | "pending" | "absent"> {
  const grant = await storedGrant(env, botId, grantId);
  if (!grant) return "absent";
  const now = Math.floor(Date.now() / 1000);
  if (grant.expiresAt !== undefined && grant.expiresAt <= now) return "absent";
  if (grant.authCodeWrappedKey) {
    if ((grant.createdAt ?? 0) + PENDING_GRANT_SECONDS <= now) {
      await env.OAUTH_PROVIDER.revokeGrant(grantId, botId);
      return "absent";
    }
    return "pending";
  }
  return "active";
}

/**
 * A mailbox is taken only by an exchanged grant that has not been revoked.
 * Approving without a token exchange does not write the row. A row whose grant is gone
 * is marked revoked so the mailbox can be chosen again. The row is not deleted.
 */
async function mailboxTaken(env: Env, botId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT grant_id, revoked_at, last_revoked_at FROM oauth_connection WHERE bot_id = ?`)
    .bind(botId)
    .first<{ grant_id: string; revoked_at: string | null; last_revoked_at: string | null }>();
  if (row?.revoked_at) return false;
  const bot = await getBot(env, botId);
  const botOff = !bot || Boolean(bot.deleted_at) || bot.enabled !== 1;
  const summaries = await listUserGrantSummaries(env, botId);
  let oldestActive: GrantSummary | undefined;
  for (const summary of summaries) {
    if (botOff) continue;
    if ((await grantState(env, botId, summary.id)) !== "active") continue;
    const grant = await storedGrant(env, botId, summary.id);
    if (!grantIssuedAtOrAfter(grant, row?.last_revoked_at ?? null)) continue;
    if (!oldestActive || summary.createdAt < oldestActive.createdAt) oldestActive = summary;
  }
  if (oldestActive) {
    if (!row) await claimConnection(env, botId, oldestActive.id);
    else if (row.grant_id !== oldestActive.id && (await grantState(env, botId, row.grant_id)) !== "active") {
      await env.DB.prepare(
        `UPDATE oauth_connection SET grant_id = ?, created_at = ? WHERE bot_id = ? AND grant_id = ? AND revoked_at IS NULL`,
      )
        .bind(oldestActive.id, nowIso(), botId, row.grant_id)
        .run();
    }
    return true;
  }
  if (!row) return false;
  if ((await grantState(env, botId, row.grant_id)) === "active") return true;
  if (botOff) return false;
  const stamp = nowIso();
  await env.DB.prepare(
    `UPDATE oauth_connection SET revoked_at = ?, last_revoked_at = ? WHERE bot_id = ? AND grant_id = ? AND revoked_at IS NULL`,
  )
    .bind(stamp, stamp, botId, row.grant_id)
    .run();
  return false;
}

async function claimConnection(env: Env, botId: string, grantId: string): Promise<"ours" | "other"> {
  const existing = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = ?`)
    .bind(botId)
    .first<{ grant_id: string; revoked_at: string | null }>();
  const stamp = nowIso();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO oauth_connection (bot_id, grant_id, created_at) VALUES (?, ?, ?)
       ON CONFLICT(bot_id) DO NOTHING`,
    )
      .bind(botId, grantId, stamp)
      .run();
  } else if (existing.revoked_at) {
    await env.DB.prepare(
      `UPDATE oauth_connection
       SET grant_id = ?, created_at = ?, revoked_at = NULL, last_revoked_at = COALESCE(last_revoked_at, revoked_at)
       WHERE bot_id = ? AND revoked_at IS NOT NULL`,
    )
      .bind(grantId, stamp, botId)
      .run();
  }
  const row = await env.DB.prepare(`SELECT grant_id FROM oauth_connection WHERE bot_id = ?`).bind(botId).first<{ grant_id: string }>();
  if (!row) throw new Error("oauth connection row missing after claim");
  return row.grant_id === grantId ? "ours" : "other";
}

async function enforceSingleConnection(options: {
  grantType: string;
  userId: string;
  grantId: string;
  props: unknown;
  env: Env;
}): Promise<void> {
  if (options.grantType !== "authorization_code" && options.grantType !== "refresh_token") return;
  const props = options.props as MailboxProps | undefined;
  if (!props || props.kind !== "bot") return;
  if (!options.userId || options.userId !== props.botId) {
    throw new OAuthError("invalid_grant", { description: "This mailbox connection is no longer valid." });
  }
  const bot = await getBot(options.env, options.userId);
  if (!bot || bot.deleted_at || bot.enabled !== 1) {
    throw new OAuthError("invalid_grant", { description: "This mailbox connection is no longer valid." });
  }
  const row = await options.env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = ?`)
    .bind(options.userId)
    .first<{ grant_id: string; revoked_at: string | null }>();
  if (row?.revoked_at) {
    const grant = await storedGrant(options.env, options.userId, options.grantId);
    // issuedAtMs is strict. Grants approved before this deploy only have createdAt in whole seconds.
    if (options.grantType === "refresh_token" || !grantIssuedAtOrAfter(grant, row.revoked_at)) {
      throw new OAuthError("invalid_grant", { description: "This mailbox connection is no longer valid." });
    }
    if ((await claimConnection(options.env, options.userId, options.grantId)) === "other") {
      throw new OAuthError("invalid_grant", { description: "This mailbox is already connected to another bot." });
    }
    return;
  }
  if (row?.grant_id === options.grantId) return;
  if (row) throw new OAuthError("invalid_grant", { description: "This mailbox is already connected to another bot." });
  if ((await claimConnection(options.env, options.userId, options.grantId)) === "other") {
    throw new OAuthError("invalid_grant", { description: "This mailbox is already connected to another bot." });
  }
}

function publicAuthorizeRequest(request: Request, env: Env): Request {
  const url = new URL(request.url);
  const origin = mcpResource(env).replace(/\/mcp$/, "");
  return new Request(new URL(`/oauth/authorize${url.search}`, origin), { method: "GET" });
}

type ConsentDetails = {
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
};

type MailboxDraft = {
  mode: "existing" | "new";
  mailbox: string;
  local: string;
  displayName: string;
  notes: string;
};

function draftFrom(form: FormData): MailboxDraft {
  const mode = String(form.get("mode") ?? "");
  const choice = String(form.get("mailbox") ?? "");
  return {
    mode: mode === "new" || (mode !== "existing" && choice === "__new__") ? "new" : "existing",
    mailbox: choice === "__new__" ? "" : choice,
    local: String(form.get("local_part") ?? ""),
    displayName: String(form.get("display_name") ?? ""),
    notes: String(form.get("notes") ?? ""),
  };
}

function consentPage(
  env: Env,
  details: ConsentDetails,
  handle: string,
  bots: BotRow[],
  error: string,
  extra?: Headers,
  draft: MailboxDraft = { mode: "existing", mailbox: "", local: "", displayName: "", notes: "" },
): Response {
  const brand = escapeHtml(env.BRAND_NAME?.trim() || "BotMail");
  const name = escapeHtml(details.clientName);
  const host = escapeHtml(details.redirectHost);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself. Its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just clicked Connect.</p>`
    : "";
  const problem = error ? `<p class="warn">${escapeHtml(error)}</p>` : "";
  const nonce = pageNonce();
  const selectedId = draft.mode === "existing" ? draft.mailbox : "";
  const options = bots
    .map((bot) => {
      const address = botMailbox(env, bot);
      const display = bot.display_name || bot.id;
      const notes = bot.notes.trim().replace(/\s+/g, " ");
      const selected = bot.id === selectedId ? " selected" : "";
      return `<option value="${escapeHtml(bot.id)}" data-name="${escapeHtml(display)}" data-address="${escapeHtml(address)}" data-notes="${escapeHtml(notes)}"${selected}>${escapeHtml(display)} — ${escapeHtml(address)}</option>`;
    })
    .join("");
  const existingChecked = draft.mode === "existing" ? " checked" : "";
  const newChecked = draft.mode === "new" ? " checked" : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connect a Grok Bot to BotMail</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:#08080a;color:#ededef;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;padding:32px 16px;
background-image:radial-gradient(600px 300px at 50% -10%,rgba(122,162,255,.14),transparent 70%),linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:auto,48px 48px,48px 48px}
.card{width:100%;max-width:560px;margin:0 auto;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:rgba(17,17,20,.92);padding:28px;box-shadow:0 20px 60px -20px rgba(0,0,0,.8)}
.eyebrow{font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#8a8f98;margin:0 0 10px}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}
p{color:#a1a1aa;margin:0 0 14px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.warn{color:#f5c16c;background:rgba(245,193,108,.08);border:1px solid rgba(245,193,108,.25);border-radius:8px;padding:10px 12px}
.hint{display:block;color:#8a8f98;font-size:12px}
.combo{display:none;position:relative;margin:0 0 16px}
.is-enhanced .combo{display:block}
.is-enhanced .native{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.native,.combo-input{width:100%;margin:0 0 16px;background:#0c0c0f;color:#ededef;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.combo-input{margin:0}
.combo-input:focus,.native:focus{outline:2px solid rgba(122,162,255,.55);outline-offset:1px}
.combo-list{position:absolute;z-index:5;left:0;right:0;top:calc(100% + 4px);max-height:280px;overflow:auto;margin:0;padding:4px;list-style:none;background:#141418;border:1px solid rgba(255,255,255,.12);border-radius:10px;box-shadow:0 16px 40px -20px rgba(0,0,0,.85)}
.combo-list li{padding:8px 10px;border-radius:8px;cursor:pointer}
.combo-list li.is-active,.combo-list li[role=option]:hover{background:#1a1a1f}
.opt-main{display:flex;gap:8px;align-items:baseline;color:#ededef}
.opt-main strong{font-weight:550}
.opt-sub,.combo-empty{display:block;color:#8a8f98;font-size:12px}
.combo-empty{cursor:default;padding:8px 10px}
.picker{display:grid;grid-template-columns:auto 1fr;column-gap:10px;row-gap:8px;margin:0 0 16px}
.mode-switch{align-self:start;margin-top:14px;accent-color:#7aa2ff}
.mode{display:block;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;background:#0c0c0f;cursor:pointer}
.mode-switch:checked + .mode{border-color:rgba(122,162,255,.75);background:rgba(122,162,255,.08)}
.mode-switch:focus-visible + .mode{outline:2px solid rgba(122,162,255,.55);outline-offset:2px}
.mode strong{display:block;color:#ededef;font-weight:600}
.mode span{display:block;color:#8a8f98;font-size:12px}
.panel-existing,.panel-new{grid-column:1 / -1}
.panel-new{display:none}
#mode-new:checked ~ .panel-new{display:block}
#mode-new:checked ~ .panel-existing{display:none}
label.field{display:block;margin:0 0 10px;color:#a1a1aa;font-size:12px}
label.field .hint{display:inline;margin-left:6px}
input[type=text],textarea{width:100%;margin-top:4px;background:#0c0c0f;color:#ededef;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
textarea{min-height:72px;resize:vertical}
.actions{display:flex;gap:8px}
button{height:36px;padding:0 14px;border-radius:8px;border:0;font-weight:550;cursor:pointer}
.approve{background:#ededef;color:#0a0a0b}
.deny{background:transparent;color:#a1a1aa;border:1px solid rgba(255,255,255,.12)}
</style></head>
<body><main class="card">
<p class="eyebrow">${brand}</p>
<h1>Connect a Grok Bot to BotMail</h1>
<p><strong>${name}</strong> is asking to connect. ${origin} Access will be sent to <strong>${host}</strong>. The token can use exactly one mailbox.</p>
<p class="hint">Mailboxes already connected to a bot are hidden. To reconnect one, revoke it on its BotMail page first.</p>
${loopback}
${problem}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<div class="picker" id="mailbox-picker">
<input class="mode-switch" type="radio" name="mode" id="mode-existing" value="existing"${existingChecked}>
<label class="mode" for="mode-existing"><strong>Existing mailbox</strong><span>Search mailboxes that are not connected yet.</span></label>
<input class="mode-switch" type="radio" name="mode" id="mode-new" value="new"${newChecked}>
<label class="mode" for="mode-new"><strong>Create a new mailbox</strong><span>A new address. These fields show only for this choice.</span></label>
<div class="panel-existing" id="existing-panel">
<label class="field" for="mailbox">Mailbox</label>
<select name="mailbox" id="mailbox" class="native">
<option value="">Choose a mailbox</option>
${options}
</select>
<div class="combo" id="mailbox-combo">
<input id="mailbox-search" class="combo-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="mailbox-list" aria-label="Mailbox" autocomplete="off" spellcheck="false" placeholder="Search name, id, address, or notes">
<ul id="mailbox-list" class="combo-list" role="listbox" hidden></ul>
</div>
</div>
<div class="panel-new" id="new-panel">
<label class="field">Local part<input class="mono" type="text" name="local_part" autocomplete="off" placeholder="herald" value="${escapeHtml(draft.local)}"></label>
<label class="field">Display name<input type="text" name="display_name" autocomplete="off" placeholder="Herald" value="${escapeHtml(draft.displayName)}"></label>
<label class="field">Notes <span class="hint">Optional</span><textarea name="notes" maxlength="2000" placeholder="What this mailbox is for">${escapeHtml(draft.notes)}</textarea></label>
</div>
</div>
<div class="actions">
<button class="approve" name="decision" value="approve">Approve</button>
<button class="deny" name="decision" value="deny">Deny</button>
</div>
</form>
<script nonce="${nonce}">${MAILBOX_COMBO_SCRIPT}</script>
</main></body></html>`;
  return htmlResponse(html, error ? 400 : 200, extra, nonce);
}

function continueToClient(redirectTo: string, extra?: Headers, message = "Approved. Sending you back to the bot."): Response {
  extra?.delete("location");
  const url = escapeHtml(redirectTo);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${url}">
<meta name="robots" content="noindex"><title>Connect a Grok Bot to BotMail</title>
<style>body{background:#08080a;color:#ededef;font:14px/1.55 system-ui,sans-serif;padding:32px 16px}main{max-width:480px;margin:0 auto}a{color:#ededef}</style>
</head><body><main>
<h1>Connect a Grok Bot to BotMail</h1>
<p>${escapeHtml(message)}</p>
<p><a href="${url}">Continue</a></p>
</main></body></html>`;
  return htmlResponse(html, 200, extra);
}

function plainPage(message: string, status: number): Response {
  return htmlResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connect a Grok Bot to BotMail</title></head><body style="background:#08080a;color:#ededef;font:14px system-ui;padding:32px"><main style="max-width:480px;margin:0 auto"><h1>Connect a Grok Bot to BotMail</h1><p>${message}</p></main></body></html>`,
    status,
  );
}

function pageNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const MAILBOX_COMBO_SCRIPT = `(function () {
  function setDisabled(root, disabled) {
    if (!root) return;
    var fields = root.querySelectorAll("input, textarea, select");
    for (var i = 0; i < fields.length; i++) fields[i].disabled = disabled;
  }
  function applyMode() {
    var creating = document.getElementById("mode-new") && document.getElementById("mode-new").checked;
    setDisabled(document.getElementById("existing-panel"), !!creating);
    setDisabled(document.getElementById("new-panel"), !creating);
  }
  var existingMode = document.getElementById("mode-existing");
  var newMode = document.getElementById("mode-new");
  if (existingMode) existingMode.addEventListener("change", applyMode);
  if (newMode) newMode.addEventListener("change", applyMode);
  applyMode();
  var select = document.getElementById("mailbox");
  var input = document.getElementById("mailbox-search");
  var list = document.getElementById("mailbox-list");
  var combo = document.getElementById("mailbox-combo");
  if (!select || !input || !list || !combo) return;
  document.documentElement.classList.add("is-enhanced");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  var label = document.querySelector('label[for="mailbox"]');
  if (label) label.setAttribute("for", "mailbox-search");
  var items = [];
  for (var i = 0; i < select.options.length; i++) {
    var opt = select.options[i];
    if (!opt.value) continue;
    items.push({
      id: opt.value,
      name: opt.getAttribute("data-name") || opt.text,
      address: opt.getAttribute("data-address") || "",
      notes: opt.getAttribute("data-notes") || "",
      create: opt.value === "__new__"
    });
  }
  var active = -1;
  var open = false;
  var current = [];
  function visible(raw) {
    var query = raw.trim().toLowerCase();
    var rows = [];
    var create = null;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.create) { create = item; continue; }
      var hay = (item.name + " " + item.id + " " + item.address + " " + item.notes).toLowerCase();
      if (!query || hay.indexOf(query) !== -1) rows.push(item);
    }
    if (create) rows.push(create);
    return rows;
  }
  function labelOf(item) {
    if (item.create) return "Create a new mailbox";
    return item.address ? item.name + " — " + item.address : item.name;
  }
  function render() {
    list.textContent = "";
    var shown = current.filter(function (item) { return !item.create; });
    if (!shown.length) {
      var empty = document.createElement("li");
      empty.className = "combo-empty";
      empty.textContent = "No matching mailbox";
      list.appendChild(empty);
    }
    for (var i = 0; i < current.length; i++) {
      var item = current[i];
      var li = document.createElement("li");
      li.id = "mailbox-opt-" + i;
      li.setAttribute("role", "option");
      li.setAttribute("data-id", item.id);
      li.setAttribute("aria-selected", select.value === item.id ? "true" : "false");
      if (i === active) li.className = "is-active";
      var main = document.createElement("span");
      main.className = "opt-main";
      var strong = document.createElement("strong");
      strong.textContent = item.create ? "Create a new mailbox" : item.name;
      main.appendChild(strong);
      if (!item.create && item.address) {
        var addr = document.createElement("span");
        addr.className = "mono";
        addr.textContent = item.address;
        main.appendChild(addr);
      }
      li.appendChild(main);
      var sub = document.createElement("span");
      sub.className = "opt-sub";
      sub.textContent = item.create ? "New address. Fill in the fields below." : "id " + item.id + (item.notes ? " · " + item.notes : "");
      li.appendChild(sub);
      list.appendChild(li);
    }
    list.hidden = !open;
    input.setAttribute("aria-expanded", open ? "true" : "false");
    input.setAttribute("aria-activedescendant", open && active >= 0 ? "mailbox-opt-" + active : "");
    var activeEl = open && active >= 0 ? document.getElementById("mailbox-opt-" + active) : null;
    if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: "nearest" });
  }
  function refresh() {
    current = visible(input.value);
    if (active >= current.length) active = current.length - 1;
    render();
  }
  function choose(item) {
    select.value = item.id;
    input.value = labelOf(item);
    open = false;
    active = -1;
    refresh();
  }
  input.addEventListener("focus", function () { open = true; if (active < 0) active = 0; refresh(); });
  input.addEventListener("input", function () { open = true; active = 0; refresh(); });
  input.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open = true;
      if (!current.length) refresh();
      active = Math.min(active + 1, Math.max(current.length - 1, 0));
      refresh();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      open = true;
      active = Math.max(active - 1, 0);
      refresh();
    } else if (event.key === "Home" && open) {
      event.preventDefault();
      active = 0;
      refresh();
    } else if (event.key === "End" && open) {
      event.preventDefault();
      active = Math.max(current.length - 1, 0);
      refresh();
    } else if (event.key === "Enter" && open && current[active]) {
      event.preventDefault();
      choose(current[active]);
    } else if (event.key === "Escape") {
      open = false;
      active = -1;
      refresh();
    }
  });
  list.addEventListener("mousedown", function (event) {
    var node = event.target;
    while (node && node !== list && !node.getAttribute("data-id")) node = node.parentNode;
    if (!node || node === list) return;
    event.preventDefault();
    var id = node.getAttribute("data-id");
    for (var i = 0; i < items.length; i++) if (items[i].id === id) choose(items[i]);
  });
  document.addEventListener("mousedown", function (event) {
    if (combo.contains(event.target)) return;
    open = false;
    active = -1;
    refresh();
  });
  for (var j = 0; j < items.length; j++) if (items[j].id === select.value) input.value = labelOf(items[j]);
  refresh();
})();`;

function htmlResponse(body: string, status: number, extra?: Headers, nonce?: string): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  const scriptSrc = nonce ? ` script-src 'nonce-${nonce}'; script-src-attr 'none';` : "";
  headers.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline';${scriptSrc} img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  return new Response(body, { status, headers });
}
