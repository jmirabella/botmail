import { botMailbox } from "./address";
import { verifiedOwnerEmail, type AccessIdentity } from "./auth";
import {
  createBot,
  deleteBot,
  getAttachmentForBot,
  restoreBot,
  getBot,
  getMessage,
  getSetting,
  listAttachments,
  loadSendConfig,
  MESSAGE_COLUMNS,
  putSetting,
  rotateBotKey,
  saveAllowlist,
  saveSendPolicy,
  saveUniqueBotNames,
  setBotOwner,
  setBotWebhook,
  uniqueBotNames,
  updateBot,
  type MessageRow,
} from "./db";
import {
  addDomain,
  apiConfigured,
  checkDomain,
  configuredDomain,
  defaultDomain,
  deleteDomain,
  dnsChecks,
  restoreDomain,
  ensureDomains,
  getDomain,
  listDomains,
  setDomainEnabled,
} from "./domains";
import { backfillAttachments, previewableImage } from "./attachments";
import { blockMessageSender, loadInboundPolicy, normalizeDailyStampLimit, normalizeRateLimit, normalizeSpamThreshold, releaseJunk, releaseQuarantine, saveInboundList, saveInboundPolicy } from "./inbound-security";
import { HttpError } from "./errors";
import { summarize } from "./mailbox";
import { approveDraft, rejectDraft } from "./outbound";
import { normalizeSendPolicy, parseAllowlistText } from "./policy";
import { createRoute, deleteRoute, listRoutes, restoreRoute, updateRoute } from "./routing";
import { UNROUTED_BOT_ID } from "./seed-bots";
import { sanitizeHtml } from "./text";
import { drainWebhooks, retryDelivery, sendTestWake } from "./webhook";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function guard(request: Request): Response | null {
  const mutate = request.method !== "GET" && request.method !== "HEAD";
  if (mutate && request.headers.get("x-bot-mail-action") !== "1") {
    return json({ error: "Missing X-Bot-Mail-Action header" }, 400);
  }
  return null;
}

export function mcpUrl(env: Env): string {
  const host = String(env.PUBLIC_HOST || "").trim().toLowerCase();
  return host ? `https://${host}/mcp` : "";
}

type PublicBotSource = {
  id: string;
  display_name: string;
  address_local: string;
  domain: string;
  notes: string;
  owner_email?: string | null;
  enabled: number;
  webhook_url: string | null;
  webhook_key_ct?: string | null;
  deleted_at?: string | null;
  api_key_hash?: string | null;
  forward_to?: string | null;
};

export function publicBot(env: Env, bot: PublicBotSource): Record<string, unknown> {
  let address = bot.address_local;
  try {
    address = botMailbox(env, bot);
  } catch {
    address = bot.address_local;
  }
  return {
    id: bot.id,
    display_name: bot.display_name,
    address_local: bot.address_local,
    domain: address.includes("@") ? address.slice(address.lastIndexOf("@") + 1) : bot.domain,
    address,
    notes: bot.notes,
    owner_email: bot.owner_email ?? null,
    enabled: bot.enabled === 1,
    archived: Boolean(bot.deleted_at),
    deleted_at: bot.deleted_at ?? null,
    key_configured: Boolean(bot.api_key_hash),
    webhook_url: bot.webhook_url,
    webhook_configured: Boolean(bot.webhook_key_ct),
    mcp_url: mcpUrl(env),
    mcp_transport: "streamable-http",
    forward_to: bot.forward_to ?? null,
  };
}

type BotStats = {
  message_count: number;
  unread_count: number;
  last_mail_at: string | null;
  webhook_status: "none" | "ok" | "failing" | "pending";
  webhook_last_at: string | null;
  webhook_last_error: string | null;
};

async function botStats(env: Env): Promise<Map<string, BotStats>> {
  const mail = await env.DB.prepare(
    `SELECT bot_id, COUNT(*) AS n, SUM(CASE WHEN direction = 'in' AND is_read = 0 AND folder != 'junk' THEN 1 ELSE 0 END) AS unread,
            MAX(COALESCE(message_date, created_at)) AS last_at
       FROM messages GROUP BY bot_id`,
  ).all<{ bot_id: string; n: number; unread: number | null; last_at: string | null }>();
  const hooks = await env.DB.prepare(
    `SELECT d.bot_id, d.status, d.updated_at, d.last_error FROM webhook_deliveries d
       JOIN (SELECT bot_id, MAX(updated_at) AS latest FROM webhook_deliveries GROUP BY bot_id) m
         ON m.bot_id = d.bot_id AND m.latest = d.updated_at`,
  ).all<{ bot_id: string; status: string; updated_at: string; last_error: string | null }>();
  const stats = new Map<string, BotStats>();
  const entry = (id: string): BotStats => {
    let found = stats.get(id);
    if (!found) {
      found = { message_count: 0, unread_count: 0, last_mail_at: null, webhook_status: "none", webhook_last_at: null, webhook_last_error: null };
      stats.set(id, found);
    }
    return found;
  };
  for (const row of mail.results) {
    const item = entry(row.bot_id);
    item.message_count = Number(row.n) || 0;
    item.unread_count = Number(row.unread) || 0;
    item.last_mail_at = row.last_at;
  }
  for (const row of hooks.results) {
    const item = entry(row.bot_id);
    item.webhook_status = row.status === "success" ? "ok" : row.status === "failed" ? "failing" : "pending";
    item.webhook_last_at = row.updated_at;
    item.webhook_last_error = row.last_error;
  }
  return stats;
}

function withStats(env: Env, bot: PublicBotSource, stats: Map<string, BotStats>): Record<string, unknown> {
  const item = stats.get(bot.id);
  return {
    ...publicBot(env, bot),
    message_count: item?.message_count ?? 0,
    unread_count: item?.unread_count ?? 0,
    last_mail_at: item?.last_mail_at ?? null,
    webhook_status: bot.webhook_url ? (item?.webhook_status ?? "none") : "none",
    webhook_last_at: item?.webhook_last_at ?? null,
    webhook_last_error: item?.webhook_last_error ?? null,
  };
}

export async function handleAdminApi(request: Request, env: Env, url: URL, identity: AccessIdentity): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  try {
    await ensureDomains(env);
    if (request.method === "GET" && url.pathname === "/admin/api/session") {
      const settings = await settingsView(env);
      return json({ email: identity.email, ...settings });
    }
    return await routeAdmin(request, env, url);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message, code: error.code, ...error.details }, error.status);
    }
    const message = error instanceof Error ? error.message : "Request failed";
    const status = /not found/i.test(message) ? 404 : 400;
    return json({ error: message }, status);
  }
}

async function routeAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/admin/api/drafts") {
    const result = await env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE status = 'pending_approval' ORDER BY created_at ASC LIMIT 100`,
    ).all<MessageRow>();
    return json({ drafts: result.results.map((row) => summarize(row)) });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/unrouted") {
    const result = await env.DB.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE bot_id = '_unrouted' ORDER BY created_at DESC LIMIT 50`,
    ).all<MessageRow>();
    return json({ messages: result.results.map((row) => summarize(row)) });
  }

  const decision = url.pathname.match(/^\/admin\/api\/drafts\/([^/]+)\/(approve|reject)$/);
  if (request.method === "POST" && decision?.[1] && decision[2]) {
    if (decision[2] === "approve") return json(await approveDraft(env, decision[1]));
    const body = await readJson(request);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    return json(await rejectDraft(env, decision[1], reason));
  }

  if (request.method === "GET" && url.pathname === "/admin/api/bots") {
    const includeArchived = url.searchParams.get("include_archived") === "1";
    const result = await env.DB.prepare(
      `SELECT id, display_name, address_local, domain, notes, owner_email, enabled, webhook_url, webhook_key_ct, deleted_at, api_key_hash, forward_to
         FROM bots WHERE (? = 1 OR deleted_at IS NULL) ORDER BY id`,
    )
      .bind(includeArchived ? 1 : 0)
      .all<PublicBotSource>();
    const stats = await botStats(env);
    return json({ bots: result.results.map((bot) => withStats(env, bot, stats)) });
  }

  if (request.method === "POST" && url.pathname === "/admin/api/bots") {
    const body = await readJson(request);
    const local = typeof body.local_part === "string" ? body.local_part : undefined;
    const id = typeof body.id === "string" ? body.id : undefined;
    if (!local?.trim() && !id?.trim()) return json({ error: "local_part is required" }, 400);
    const created = await createBot(env, {
      id,
      local,
      domain: typeof body.domain === "string" ? body.domain : undefined,
      displayName: typeof body.display_name === "string" ? body.display_name : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      ownerEmail: await verifiedOwnerEmail(request, env),
    });
    return json({ ...publicBot(env, created.bot), api_key: created.apiKey, authorization: `Bearer ${created.apiKey}` }, 201);
  }

  const connectorsRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/connectors$/);
  if (request.method === "GET" && connectorsRoute?.[1]) {
    const id = decodeURIComponent(connectorsRoute[1]);
    const bot = await getBot(env, id);
    if (!bot || bot.id === UNROUTED_BOT_ID) return json({ error: "Bot not found" }, 404);
    const { listMailboxConnectors } = await import("./oauth");
    return json({ connectors: await listMailboxConnectors(env, id) });
  }

  const revokeRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/connectors\/([^/]+)\/revoke$/);
  if (request.method === "POST" && revokeRoute?.[1] && revokeRoute[2]) {
    const id = decodeURIComponent(revokeRoute[1]);
    const grantId = decodeURIComponent(revokeRoute[2]);
    const bot = await getBot(env, id);
    if (!bot || bot.id === UNROUTED_BOT_ID) return json({ error: "Bot not found" }, 404);
    const { revokeMailboxConnector } = await import("./oauth");
    await revokeMailboxConnector(env, id, grantId);
    return json({ revoked: true, grant_id: grantId });
  }

  const keyRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/key$/);
  if (request.method === "POST" && keyRoute?.[1]) {
    const apiKey = await rotateBotKey(env, decodeURIComponent(keyRoute[1]));
    return json({ bot: decodeURIComponent(keyRoute[1]), api_key: apiKey, authorization: `Bearer ${apiKey}` });
  }

  const wakeRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/test-wake$/);
  if (request.method === "POST" && wakeRoute?.[1]) {
    return json(await sendTestWake(env, decodeURIComponent(wakeRoute[1])));
  }

  const hookRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/webhook$/);
  if (request.method === "PUT" && hookRoute?.[1]) {
    const body = await readJson(request);
    if (typeof body.url !== "string") return json({ error: "url is required" }, 400);
    const key = typeof body.key === "string" ? body.key : undefined;
    const id = decodeURIComponent(hookRoute[1]);
    await setBotWebhook(env, id, body.url, key);
    const bot = await getBot(env, id);
    return json({ bot: id, webhook_url: body.url, webhook_configured: Boolean(bot?.webhook_key_ct) });
  }

  const botRoute = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)$/);
  if (botRoute?.[1] && request.method === "GET") {
    const bot = await getBot(env, decodeURIComponent(botRoute[1]));
    if (!bot) return json({ error: "Bot not found" }, 404);
    return json({ bot: withStats(env, bot, await botStats(env)) });
  }
  if (botRoute?.[1] && request.method === "PATCH") {
    const body = await readJson(request);
    const id = decodeURIComponent(botRoute[1]);
    const touchesOwner = Object.prototype.hasOwnProperty.call(body, "owner_email");
    const touchesProfile =
      typeof body.display_name === "string" ||
      typeof body.enabled === "boolean" ||
      typeof body.notes === "string" ||
      typeof body.address_local === "string" ||
      typeof body.domain === "string" ||
      Object.prototype.hasOwnProperty.call(body, "forward_to");
    if (!touchesProfile && touchesOwner) {
      return json({ bot: publicBot(env, await setBotOwner(env, id, body.owner_email)) });
    }
    const bot = await updateBot(env, id, {
      displayName: typeof body.display_name === "string" ? body.display_name : undefined,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      addressLocal: typeof body.address_local === "string" ? body.address_local : undefined,
      domain: typeof body.domain === "string" ? body.domain : undefined,
      forwardTo: Object.prototype.hasOwnProperty.call(body, "forward_to")
        ? body.forward_to == null || body.forward_to === ""
          ? null
          : String(body.forward_to)
        : undefined,
    });
    return json({ bot: publicBot(env, touchesOwner ? await setBotOwner(env, id, body.owner_email) : bot) });
  }
  const botRestore = url.pathname.match(/^\/admin\/api\/bots\/([^/]+)\/restore$/);
  if (request.method === "POST" && botRestore?.[1]) {
    return json({ bot: publicBot(env, await restoreBot(env, decodeURIComponent(botRestore[1]))) });
  }
  if (botRoute?.[1] && request.method === "DELETE") {
    const id = decodeURIComponent(botRoute[1]);
    await deleteBot(env, id);
    return json({ archived: id });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/mail") {
    return json(await listMail(env, url));
  }

  const rawRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)\/raw$/);
  if (request.method === "GET" && rawRoute?.[1]) {
    return rawMessage(env, decodeURIComponent(rawRoute[1]));
  }

  const attachmentRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)\/attachments\/([^/]+)$/);
  if (request.method === "GET" && attachmentRoute?.[1] && attachmentRoute[2]) {
    const row = await getMessage(env, decodeURIComponent(attachmentRoute[1]));
    if (!row) return json({ error: "Message not found" }, 404);
    const item = await getAttachmentForBot(env, row.bot_id, decodeURIComponent(attachmentRoute[2]));
    if (!item || item.message_id !== row.id) return json({ error: "Attachment not found" }, 404);
    const object = await env.MAIL_BUCKET.get(item.r2_key);
    if (!object) return json({ error: "Attachment missing" }, 404);
    const headers = new Headers();
    const filename = (item.filename || item.id).replaceAll('"', "").replace(/[\r\n]/g, "");
    const inline = previewableImage(item.content_type);
    headers.set("content-type", item.content_type || "application/octet-stream");
    headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="${filename}"`);
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  }

  const releaseRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)\/release$/);
  if (request.method === "POST" && releaseRoute?.[1]) {
    const row = await releaseQuarantine(env, decodeURIComponent(releaseRoute[1]));
    return json({ message: summarize(row) });
  }
  const notJunkRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)\/not-junk$/);
  if (request.method === "POST" && notJunkRoute?.[1]) {
    const row = await releaseJunk(env, decodeURIComponent(notJunkRoute[1]));
    return json({ message: summarize(row) });
  }
  const blockRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)\/block-sender$/);
  if (request.method === "POST" && blockRoute?.[1]) {
    return json(await blockMessageSender(env, decodeURIComponent(blockRoute[1])));
  }

  const mailRoute = url.pathname.match(/^\/admin\/api\/mail\/([^/]+)$/);
  if (request.method === "PATCH" && mailRoute?.[1]) {
    const body = await readJson(request);
    if (typeof body.is_read !== "boolean") return json({ error: "is_read must be a boolean" }, 400);
    const id = decodeURIComponent(mailRoute[1]);
    const updated = await env.DB.prepare(`UPDATE messages SET is_read = ?, updated_at = ? WHERE id = ?`)
      .bind(body.is_read ? 1 : 0, new Date().toISOString(), id)
      .run();
    if (!updated.meta.changes) return json({ error: "Message not found" }, 404);
    return json({ id, is_read: body.is_read });
  }
  if (request.method === "GET" && mailRoute?.[1]) {
    const row = await getMessage(env, decodeURIComponent(mailRoute[1]));
    if (!row) return json({ error: "Message not found" }, 404);
    const attachments = await listAttachments(env, row.id, row.bot_id);
    return json({
      message: {
        ...summarize(row),
        references: row.references_header,
        text: row.text_body,
        html: sanitizeHtml(row.html_body ?? ""),
        body_truncated: row.body_truncated === 1,
        raw_size: row.raw_size,
        headers: {
          from: row.from_addr,
          to: summarize(row).to,
          cc: summarize(row).cc,
          subject: row.subject,
          date: row.message_date,
          message_id: row.message_id_header,
          in_reply_to: row.in_reply_to,
          references: row.references_header,
        },
        attachments: attachments.map((item) => ({
          id: item.id,
          filename: item.filename,
          content_type: item.content_type,
          size_bytes: item.size_bytes,
          disposition: item.disposition,
          content_id: item.content_id,
          inline: item.inline === 1,
        })),
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/routes") {
    const policy = await getSetting(env, "unknown_policy");
    const unknownBot = await getSetting(env, "unknown_bot");
    const includeArchived = url.searchParams.get("include_archived") === "1";
    return json({ routes: await listRoutes(env, includeArchived), unknown_policy: policy || "unrouted", unknown_bot: unknownBot });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/routes") {
    const body = await readJson(request);
    const route = await createRoute(env, {
      kind: String(body.kind ?? ""),
      localPart: String(body.local_part ?? ""),
      domain: typeof body.domain === "string" ? body.domain : undefined,
      target: String(body.target ?? ""),
      targets: Array.isArray(body.targets) ? body.targets.map((item) => String(item)) : undefined,
    });
    return json({ route }, 201);
  }
  if (request.method === "PUT" && url.pathname === "/admin/api/routes/unknown") {
    const body = await readJson(request);
    const policy = String(body.unknown_policy ?? "");
    if (policy !== "unrouted" && policy !== "reject" && policy !== "default_bot") {
      return json({ error: "unknown_policy must be unrouted, reject, or default_bot" }, 400);
    }
    await putSetting(env, "unknown_policy", policy);
    if (typeof body.unknown_bot === "string") {
      const bot = body.unknown_bot.trim().toLowerCase();
      if (bot && bot !== UNROUTED_BOT_ID) {
        const row = await getBot(env, bot);
        if (!row) return json({ error: "default bot was not found" }, 400);
      }
      await putSetting(env, "unknown_bot", bot);
    }
    return json({ unknown_policy: policy, unknown_bot: await getSetting(env, "unknown_bot") });
  }
  const routeId = url.pathname.match(/^\/admin\/api\/routes\/([^/]+)$/);
  if (routeId?.[1] && request.method === "PATCH") {
    const body = await readJson(request);
    const route = await updateRoute(env, decodeURIComponent(routeId[1]), {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      target: typeof body.target === "string" ? body.target : undefined,
      targets: Array.isArray(body.targets) ? body.targets.map((item) => String(item)) : undefined,
    });
    return json({ route });
  }
  const routeRestore = url.pathname.match(/^\/admin\/api\/routes\/([^/]+)\/restore$/);
  if (request.method === "POST" && routeRestore?.[1]) {
    return json({ route: await restoreRoute(env, decodeURIComponent(routeRestore[1])) });
  }
  if (routeId?.[1] && request.method === "DELETE") {
    const id = decodeURIComponent(routeId[1]);
    await deleteRoute(env, id);
    return json({ archived: id });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/settings") {
    return json(await settingsView(env));
  }
  if (request.method === "PUT" && url.pathname === "/admin/api/settings") {
    const body = await readJson(request);
    if (typeof body.send_policy === "string") {
      const policy = normalizeSendPolicy(body.send_policy);
      if (!policy) return json({ error: 'send_policy must be "direct" or "approval"' }, 400);
      const source = body.send_policy_source === "config" ? "config" : "dashboard";
      await saveSendPolicy(env, policy, source);
    } else if (body.send_policy_source === "config" || body.send_policy_source === "dashboard") {
      await putSetting(env, "send_policy_source", body.send_policy_source);
    }
    if (Array.isArray(body.allowlist)) {
      await saveAllowlist(env, body.allowlist.map((entry) => String(entry)));
    }
    if (body.inbound_policy_source === "config") {
      await saveInboundPolicy(env, { source: "config" });
    } else {
      // inbound_auth is a retired mode. Ignore it so an older client can still save the limits.
      if (typeof body.inbound_rate_limit === "number") {
        const rateLimit = normalizeRateLimit(body.inbound_rate_limit);
        if (!rateLimit) return json({ error: "inbound_rate_limit must be an integer from 1 to 1000" }, 400);
        await saveInboundPolicy(env, { rateLimit, source: "dashboard" });
      }
      if (typeof body.inbound_bot_rate_limit === "number") {
        const botRateLimit = normalizeRateLimit(body.inbound_bot_rate_limit);
        if (!botRateLimit) return json({ error: "inbound_bot_rate_limit must be an integer from 1 to 1000" }, 400);
        await saveInboundPolicy(env, { botRateLimit, source: "dashboard" });
      }
      if (typeof body.inbound_auto_reply_limit === "number") {
        const autoReplyLimit = normalizeRateLimit(body.inbound_auto_reply_limit);
        if (!autoReplyLimit) return json({ error: "inbound_auto_reply_limit must be an integer from 1 to 1000" }, 400);
        await saveInboundPolicy(env, { autoReplyLimit, source: "dashboard" });
      }
      if (typeof body.outbound_daily_stamp_limit === "number") {
        const dailyStampLimit = normalizeDailyStampLimit(body.outbound_daily_stamp_limit);
        if (!dailyStampLimit) return json({ error: "outbound_daily_stamp_limit must be an integer from 1 to 10000" }, 400);
        await saveInboundPolicy(env, { dailyStampLimit, source: "dashboard" });
      }
      if (Object.prototype.hasOwnProperty.call(body, "spam_score_threshold")) {
        if (body.spam_score_threshold === null) {
          await saveInboundPolicy(env, { spamThreshold: "off" });
        } else if (typeof body.spam_score_threshold === "number") {
          const spamThreshold = normalizeSpamThreshold(body.spam_score_threshold);
          if (typeof spamThreshold !== "number") return json({ error: "spam_score_threshold must be an integer from 1 to 5, or null to turn Junk off" }, 400);
          await saveInboundPolicy(env, { spamThreshold });
        } else {
          return json({ error: "spam_score_threshold must be an integer from 1 to 5, or null to turn Junk off" }, 400);
        }
      }
    }
    if (Array.isArray(body.inbound_allowlist)) {
      await saveInboundList(env, "allow", body.inbound_allowlist.map((entry) => String(entry)));
    }
    if (Array.isArray(body.inbound_blocklist)) {
      await saveInboundList(env, "block", body.inbound_blocklist.map((entry) => String(entry)));
    }
    if (typeof body.unique_bot_names === "boolean" || body.unique_bot_names === null) {
      await saveUniqueBotNames(env, body.unique_bot_names);
    }
    if (typeof body.brand_name === "string") await putSetting(env, "brand_name", body.brand_name.trim().slice(0, 80));
    if (typeof body.brand_logo === "string") {
      const logo = body.brand_logo.trim();
      if (logo && !logo.startsWith("https://")) return json({ error: "brand_logo must be an https URL" }, 400);
      await putSetting(env, "brand_logo", logo);
    }
    if (typeof body.brand_accent === "string") {
      const accent = body.brand_accent.trim();
      if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) return json({ error: "brand_accent must be #rrggbb" }, 400);
      await putSetting(env, "brand_accent", accent);
    }
    return json(await settingsView(env));
  }

  if (request.method === "PUT" && url.pathname === "/admin/api/allowlist") {
    const body = await readJson(request);
    if (!Array.isArray(body.entries)) return json({ error: "entries must be an array" }, 400);
    return json({ allowlist: await saveAllowlist(env, body.entries.map((entry) => String(entry))) });
  }

  if (request.method === "POST" && url.pathname === "/admin/api/attachments/backfill") {
    const body = await readJson(request);
    const limit = typeof body.limit === "number" ? body.limit : 25;
    return json(await backfillAttachments(env, limit));
  }

  if (request.method === "POST" && url.pathname === "/admin/api/webhooks/drain") {
    return json(await drainWebhooks(env, 20));
  }

  const retryRoute = url.pathname.match(/^\/admin\/api\/webhooks\/([^/]+)\/retry$/);
  if (request.method === "POST" && retryRoute?.[1]) {
    return json(await retryDelivery(env, decodeURIComponent(retryRoute[1])));
  }

  if (request.method === "GET" && url.pathname === "/admin/api/domains") {
    const includeArchived = url.searchParams.get("include_archived") === "1";
    const domains = await Promise.all(
      (await listDomains(env, includeArchived)).map((view) => (view.enabled && !view.archived && !view.checked_at ? checkDomain(env, view.domain, false).catch(() => view) : view)),
    );
    return json({ domains, api_configured: apiConfigured(env) });
  }
  if (request.method === "POST" && url.pathname === "/admin/api/domains") {
    const body = await readJson(request);
    return json({ domain: await addDomain(env, String(body.domain ?? "")) }, 201);
  }
  const domainCheck = url.pathname.match(/^\/admin\/api\/domains\/([^/]+)\/check$/);
  if (request.method === "POST" && domainCheck?.[1]) {
    return json({ domain: await checkDomain(env, decodeURIComponent(domainCheck[1])) });
  }
  const domainRoute = url.pathname.match(/^\/admin\/api\/domains\/([^/]+)$/);
  if (domainRoute?.[1] && request.method === "GET") {
    return json({ domain: await getDomain(env, decodeURIComponent(domainRoute[1])) });
  }
  if (domainRoute?.[1] && request.method === "PATCH") {
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
    return json({ domain: await setDomainEnabled(env, decodeURIComponent(domainRoute[1]), body.enabled) });
  }
  const domainRestore = url.pathname.match(/^\/admin\/api\/domains\/([^/]+)\/restore$/);
  if (request.method === "POST" && domainRestore?.[1]) {
    return json({ domain: await restoreDomain(env, decodeURIComponent(domainRestore[1])) });
  }
  if (domainRoute?.[1] && request.method === "DELETE") {
    const domain = decodeURIComponent(domainRoute[1]);
    await deleteDomain(env, domain);
    return json({ archived: domain });
  }

  if (request.method === "GET" && url.pathname === "/admin/api/health") {
    return json(await healthView(env));
  }

  return json({ error: "Not found" }, 404);
}

const MAIL_PAGE_DEFAULT = 50;
const MAIL_PAGE_MAX = 100;

function mailPageSize(raw: string | null): number {
  if (raw === null || raw.trim() === "") return MAIL_PAGE_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return MAIL_PAGE_DEFAULT;
  return Math.min(Math.floor(value), MAIL_PAGE_MAX);
}

type MailCursor = { t: string; id: string };

function encodeMailCursor(received: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: received, id }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeMailCursor(value: string): MailCursor {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new HttpError("cursor is invalid", 400, "invalid_cursor");
  try {
    const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.id !== "string") throw new Error("bad cursor");
    if (!parsed.t || parsed.t.length > 200 || !parsed.id || parsed.id.length > 100) throw new Error("bad cursor");
    return { t: parsed.t, id: parsed.id };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("cursor is invalid", 400, "invalid_cursor");
  }
}

function receivedAt(row: MessageRow): string {
  return row.message_date ?? row.created_at;
}

async function listMail(env: Env, url: URL): Promise<{ messages: ReturnType<typeof summarize>[]; next_cursor: string | null }> {
  const where = ["1 = 1"];
  const binds: Array<string | number> = [];
  const bot = url.searchParams.get("bot")?.trim().toLowerCase() ?? "";
  const direction = url.searchParams.get("direction")?.trim() ?? "";
  const folder = url.searchParams.get("folder")?.trim().toLowerCase() ?? "";
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (bot) {
    where.push("bot_id = ?");
    binds.push(bot);
  }
  if (direction === "in" || direction === "out") {
    where.push("direction = ?");
    binds.push(direction);
  }
  if (folder === "quarantine") {
    where.push("folder = 'quarantine'");
  } else if (folder === "junk") {
    where.push("folder = 'junk'");
  } else if (direction === "in") {
    where.push("folder != 'quarantine' AND folder != 'junk'");
  }
  if (url.searchParams.get("unread") === "1") where.push("is_read = 0");
  if (q) {
    const needle = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    where.push(`(subject LIKE ? ESCAPE '\\' OR from_addr LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\' OR to_addrs LIKE ? ESCAPE '\\')`);
    binds.push(needle, needle, needle, needle);
  }
  const cursorRaw = url.searchParams.get("cursor")?.trim() ?? "";
  const cursor = cursorRaw ? decodeMailCursor(cursorRaw) : null;
  if (cursor) {
    where.push(`(COALESCE(message_date, created_at) < ? OR (COALESCE(message_date, created_at) = ? AND id < ?))`);
    binds.push(cursor.t, cursor.t, cursor.id);
  }
  const limit = mailPageSize(url.searchParams.get("limit"));
  const result = await env.DB.prepare(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(message_date, created_at) DESC, id DESC
     LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<MessageRow>();
  const page = result.results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = result.results.length > limit && last ? encodeMailCursor(receivedAt(last), last.id) : null;
  return { messages: page.map((row) => summarize(row)), next_cursor: nextCursor };
}

async function rawMessage(env: Env, id: string): Promise<Response> {
  const row = await getMessage(env, id);
  if (!row?.r2_key) return json({ error: "Message not found" }, 404);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: "Raw message is missing" }, 404);
  const headers = new Headers();
  headers.set("content-type", "message/rfc822");
  headers.set("content-disposition", `attachment; filename="${row.id}.eml"`);
  headers.set("cache-control", "private, no-store");
  return new Response(object.body, { headers });
}

async function settingsView(env: Env) {
  const active = await loadSendConfig(env);
  const inbound = await loadInboundPolicy(env);
  const stored = normalizeSendPolicy(await getSetting(env, "send_policy"));
  const source = (await getSetting(env, "send_policy_source")) || "config";
  const unique = await uniqueBotNames(env);
  const domains = await env.DB.prepare(
    `SELECT domain, is_default, enabled FROM mail_domains WHERE deleted_at IS NULL ORDER BY is_default DESC, domain`,
  ).all<{ domain: string; is_default: number; enabled: number }>();
  return {
    send_policy: active.policy,
    send_policy_stored: stored,
    send_policy_source: source,
    locked_by_env: source !== "dashboard" && normalizeSendPolicy(env.SEND_POLICY) !== null,
    allowlist: active.allowlist,
    allowlist_extra: parseAllowlistText(await getSetting(env, "send_allowlist")),
    inbound_policy_source: inbound.source,
    spam_score_threshold: inbound.spamThreshold === "off" ? null : inbound.spamThreshold,
    inbound_rate_limit: inbound.rateLimit,
    inbound_bot_rate_limit: inbound.botRateLimit,
    inbound_auto_reply_limit: inbound.autoReplyLimit,
    outbound_daily_stamp_limit: inbound.dailyStampLimit,
    inbound_allowlist: inbound.allowlist,
    inbound_blocklist: inbound.blocklist,
    unknown_policy: (await getSetting(env, "unknown_policy")) || "unrouted",
    unknown_bot: await getSetting(env, "unknown_bot"),
    brand_name: (await getSetting(env, "brand_name")) || env.BRAND_NAME || "BotMail",
    brand_logo: (await getSetting(env, "brand_logo")) || env.BRAND_LOGO || "",
    brand_accent: (await getSetting(env, "brand_accent")) || env.BRAND_ACCENT || "#7aa2ff",
    mail_domain: await defaultDomain(env).catch(() => configuredDomain(env) ?? ""),
    domains: domains.results.map((row) => ({ domain: row.domain, is_default: row.is_default === 1, enabled: row.enabled === 1 })),
    unique_bot_names: unique.value,
    unique_bot_names_source: unique.source,
    unique_bot_names_config: unique.config,
    cf_api_configured: apiConfigured(env),
    public_host: String(env.PUBLIC_HOST || ""),
    admin_host: String(env.ADMIN_HOST || ""),
    mcp_url: mcpUrl(env),
    routing_mode: String(env.ROUTING_MODE || "") === "literal" ? "literal" : "catch-all",
  };
}

async function healthView(env: Env) {
  const deliveries = await env.DB.prepare(
    `SELECT id, bot_id, message_id, url, status, attempts, last_status_code, last_error, created_at, updated_at
     FROM webhook_deliveries ORDER BY updated_at DESC LIMIT 40`,
  ).all();
  const counts = await env.DB.prepare(
    `SELECT direction, status, COUNT(*) AS n FROM messages GROUP BY direction, status`,
  ).all<{ direction: string; status: string; n: number }>();
  return {
    deliveries: deliveries.results,
    counts: counts.results,
    dns: await dnsStatus(env),
  };
}

async function dnsStatus(env: Env): Promise<Record<string, unknown>> {
  const domain = configuredDomain(env) ? await defaultDomain(env) : "";
  if (!domain) return { ok: false, domain: "", checks: [], error: "MAIL_DOMAIN is not configured" };
  const checks = await dnsChecks(domain);
  return { ok: checks.every((item) => item.state === "ok"), domain, checks };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") return {};
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}
