import { handleAdminApi } from "./admin-api";
import { readSignedAttachment } from "./attachments";
import { accessConfigured, accessIdentity } from "./auth";
import { getSetting } from "./db";
import { logError } from "./log";
import { escapeHtml } from "./text";
import { handleWebhookSetup } from "./webhook-setup";

const DASHBOARD_ROUTES = [
  /^\/mail$/,
  /^\/mail\/[^/]+$/,
  /^\/bots$/,
  /^\/bots\/[^/]+$/,
  /^\/routing$/,
  /^\/domains$/,
  /^\/health$/,
  /^\/settings$/,
];

const LEGACY_REDIRECTS: Record<string, string> = {
  "/admin": "/mail",
  "/admin/": "/mail",
  "/connect": "/bots",
};

const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function isDashboardRoute(pathname: string): boolean {
  return DASHBOARD_ROUTES.some((pattern) => pattern.test(pathname));
}

export function isAdminHost(url: URL, env: Env): boolean {
  const expected = String(env.ADMIN_HOST || "").trim().toLowerCase();
  return Boolean(expected) && url.hostname.toLowerCase() === expected;
}

export async function handleHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  try {
    const attachment = url.pathname.match(/^\/attachments\/([^/]+)$/);
    if (request.method === "GET" && attachment?.[1]) {
      return serveAttachment(request, env, attachment[1]);
    }
    if (isAdminHost(url, env)) return await handleAdminHost(request, env, url);
    if (request.method === "POST" && url.pathname === "/webhook-setup") return handleWebhookSetup(request, env);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, mail_domain_configured: Boolean(env.MAIL_DOMAIN?.trim()) });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(await brandName(env), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    logError("http_failed", { path: url.pathname, error: message });
    return json({ error: "Internal server error" }, 500);
  }
}

async function handleAdminHost(request: Request, env: Env, url: URL): Promise<Response> {
  const identity = await accessIdentity(request, env);
  if (url.pathname.startsWith("/admin/api/")) {
    if (!identity) return json({ error: "Cloudflare Access required" }, 401);
    return handleAdminApi(request, env, url, identity);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
  if (!identity) return accessRequired(env, url);

  if (url.pathname === "/") return Response.redirect(new URL("/mail", url).toString(), 302);
  const legacy = LEGACY_REDIRECTS[url.pathname];
  if (legacy) return Response.redirect(new URL(legacy, url).toString(), 301);
  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg") {
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }
  return dashboardShell(env, url, isDashboardRoute(url.pathname) ? 200 : 404);
}

async function dashboardShell(env: Env, url: URL, status: number): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", url)));
  if (!asset.ok) {
    return new Response("Dashboard bundle is missing. Run npm run build, then deploy again.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": SHELL_CSP,
  });
  return withSecurityHeaders(new Response(asset.body, { status, headers }));
}

function withSecurityHeaders(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set("x-content-type-options", "nosniff");
  next.headers.set("referrer-policy", "no-referrer");
  next.headers.set("x-frame-options", "DENY");
  return next;
}

export async function accessRequired(env: Env, url: URL): Promise<Response> {
  const brand = escapeHtml(await brandName(env));
  const configured = accessConfigured(env);
  const detail = configured
    ? "This dashboard is protected by Cloudflare Access. Sign in with an allowed work email to continue. If you just signed in, your session may have expired."
    : "Cloudflare Access is not configured for this Worker, so the dashboard stays locked. Set access.teamDomain and access.allowedEmailDomains in the group config, then run setup again.";
  const action = configured
    ? `<a class="btn" href="${escapeHtml(url.pathname)}">Sign in with Cloudflare Access</a>`
    : `<code>npm run setup</code>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Access required · ${brand}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{background:#08080a;color:#ededef;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;display:grid;place-items:center;padding:24px;
background-image:radial-gradient(600px 300px at 50% -10%,rgba(122,162,255,.14),transparent 70%),linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:auto,48px 48px,48px 48px}
.card{width:100%;max-width:420px;border:1px solid rgba(255,255,255,.09);border-radius:14px;background:rgba(17,17,20,.92);padding:28px;box-shadow:0 20px 60px -20px rgba(0,0,0,.8)}
.mark{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(180deg,#1b1b21,#121216);border:1px solid rgba(255,255,255,.1);margin-bottom:20px}
.eyebrow{font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;color:#8a8f98;margin:0 0 10px}
h1{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}
p{color:#a1a1aa;margin:0 0 22px}
.btn{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:8px;background:#ededef;color:#0a0a0b;font-weight:500;text-decoration:none}
.btn:hover{background:#fff}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#141418;border:1px solid rgba(255,255,255,.09);border-radius:6px;padding:6px 10px;color:#9ee6b8}
.foot{margin-top:22px;padding-top:16px;border-top:1px solid rgba(255,255,255,.07);font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b6f78}
</style></head>
<body><main class="card">
<div class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ededef" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>
<p class="eyebrow">${brand} · Zero Trust</p>
<h1>Access required</h1>
<p>${detail}</p>
${action}
<div class="foot">${escapeHtml(url.hostname)}</div>
</main></body></html>`;
  return new Response(html, {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function brandName(env: Env): Promise<string> {
  const stored = (await getSetting(env, "brand_name")).trim();
  return stored || env.BRAND_NAME?.trim() || "BotMail";
}

async function serveAttachment(request: Request, env: Env, attachmentId: string): Promise<Response> {
  const row = await readSignedAttachment(request, env, attachmentId);
  if (!row) return json({ error: "Attachment link is invalid or expired" }, 403);
  const object = await env.MAIL_BUCKET.get(row.r2_key);
  if (!object) return json({ error: "Attachment missing" }, 404);
  const headers = new Headers();
  headers.set("content-type", row.content_type || "application/octet-stream");
  if (row.filename) headers.set("content-disposition", `attachment; filename="${row.filename.replaceAll('"', "")}"`);
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { headers });
}
