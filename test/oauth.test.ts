import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createBot, getBot, rotateBotKey, setBotWebhook, updateBot } from "../src/db";
import { adminRequest, base64UrlBytes, deliver, mcpCall, rawMime } from "./helpers";

const origin = `https://${env.PUBLIC_HOST}`;
const resource = `${origin}/mcp`;

describe("MCP OAuth", () => {
  it("challenges /mcp and publishes the authorization server", async () => {
    const denied = await worker.fetch(
      new Request(resource, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(denied.status).toBe(401);
    const challenge = denied.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="mailbox"');

    const protectedResource = await worker.fetch(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`), env);
    expect(protectedResource.status).toBe(200);
    const resourceDoc = (await protectedResource.json()) as { resource: string; authorization_servers: string[] };
    expect(resourceDoc.resource).toBe(resource);
    expect(resourceDoc.authorization_servers).toContain(origin);

    const metadata = await worker.fetch(new Request(`${origin}/.well-known/oauth-authorization-server`), env);
    expect(metadata.status).toBe(200);
    const server = (await metadata.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(server.authorization_endpoint).toBe(`${origin}/oauth/authorize`);
    expect(server.token_endpoint).toBe(`${origin}/oauth/token`);
    expect(server.registration_endpoint).toBe(`${origin}/oauth/register`);
    expect(server.code_challenge_methods_supported).toContain("S256");

    const locked = await worker.fetch(new Request(`${origin}/oauth/authorize?response_type=code`), env);
    expect(locked.status).toBe(302);
    expect(locked.headers.get("location")).toContain(`https://${env.ADMIN_HOST}/oauth/authorize`);
    const page = await worker.fetch(await adminRequest("/oauth/authorize?response_type=code", {}, { jwt: null }), env);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Access required");
  });

  it("issues a mailbox-scoped token and keeps static bearer keys working", async () => {
    const postKey = await rotateBotKey(env, "post");
    const postList = (await mcpCall(postKey, "list_messages", {})) as { messages: unknown[] };
    expect(Array.isArray(postList.messages)).toBe(true);

    const secret = "Vespa oauth fence 4c1e";
    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "vespa@bots.example.test",
        subject: secret,
        text: "private",
        messageId: "<oauth-vespa@bots.example.test>",
      }),
      "ada@example.com",
      "vespa@bots.example.test",
    );
    const connected = await connectMailbox("forge", "Grok Forge");
    const forgeList = (await mcpCall(connected.accessToken, "list_messages", {})) as { messages: Array<{ subject: string }> };
    expect(forgeList.messages.some((message) => message.subject === secret)).toBe(false);

    const rotated = await refresh(connected.refreshToken, connected.clientId);
    const again = await refresh(rotated.refreshToken, connected.clientId);
    await expect(refresh(connected.refreshToken, connected.clientId)).rejects.toThrow(/invalid_grant|400/);
    const stillForge = (await mcpCall(again.accessToken, "list_messages", {})) as { messages: Array<{ subject: string }> };
    expect(stillForge.messages.some((message) => message.subject === secret)).toBe(false);

    await env.DB.prepare(`UPDATE oauth_connection SET grant_id = ? WHERE bot_id = ?`).bind("other-grant", "forge").run();
    await expect(refresh(again.refreshToken, connected.clientId)).rejects.toThrow(/invalid_grant|400/);
    const postStill = (await mcpCall(postKey, "list_messages", {})) as { messages: unknown[] };
    expect(Array.isArray(postStill.messages)).toBe(true);
  });

  it("lists the connected client and revoke stops the token", async () => {
    const pending = await beginConsent("Grok Glyph");
    const approved = await postMailbox(pending, "glyph");
    const approvedHtml = await approved.text();
    expect(approved.status).toBe(200);
    expect(approved.headers.get("location")).toBeNull();
    expect(approvedHtml).toContain('http-equiv="refresh"');
    expect(approvedHtml).toContain("Approved. Sending you back to the bot.");
    const firstRedirect = redirectFromContinue(approvedHtml);
    expect(firstRedirect.startsWith("http://127.0.0.1/callback?")).toBe(true);
    expect(new URL(firstRedirect).searchParams.get("code")).toBeTruthy();
    expect(await env.DB.prepare(`SELECT grant_id FROM oauth_connection WHERE bot_id = ?`).bind("glyph").first()).toBeNull();

    const retry = await beginConsent("Grok Glyph", pending.clientId);
    expect(retry.html).toContain('value="glyph"');
    const againApproved = await postMailbox(retry, "glyph");
    const againHtml = await againApproved.text();
    expect(againApproved.status).toBe(200);
    const code = new URL(redirectFromContinue(againHtml)).searchParams.get("code");
    expect(code).toBeTruthy();
    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "http://127.0.0.1/callback",
      client_id: retry.clientId,
      code_verifier: retry.verifier,
      resource,
    });
    const accessToken = tokens.access_token;
    await mcpCall(accessToken, "list_messages", {});

    const second = await beginConsent("Grok Glyph Two");
    expect(second.html).toContain("Mailboxes already connected to a bot are hidden. To reconnect one, revoke it on its BotMail page first.");
    expect(second.html).not.toContain('value="glyph"');
    expect(second.html).toContain("Create a new mailbox");
    const rejected = await postMailbox(second, "glyph");
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("already connected");
    await mcpCall(accessToken, "list_messages", {});

    const listed = await worker.fetch(await adminRequest("/admin/api/bots/glyph/connectors"), env);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { connectors: Array<{ grant_id: string; client_name: string; created_at: string; last_used_at: string | null }> };
    const row = body.connectors.find((connector) => connector.client_name === "Grok Glyph");
    expect(row?.created_at).toBeTruthy();
    expect(row?.last_used_at).toBeTruthy();

    const revoked = await worker.fetch(
      await adminRequest(`/admin/api/bots/glyph/connectors/${encodeURIComponent(row!.grant_id)}/revoke`, {
        method: "POST",
        headers: { "x-bot-mail-action": "1" },
      }),
      env,
    );
    expect(revoked.status).toBe(200);
    await expect(mcpCall(accessToken, "list_messages", {})).rejects.toThrow(/401/);
    const after = await worker.fetch(await adminRequest("/admin/api/bots/glyph/connectors"), env);
    const remaining = (await after.json()) as { connectors: Array<{ client_name: string }> };
    expect(remaining.connectors.some((connector) => connector.client_name === "Grok Glyph")).toBe(false);

    const again = await connectMailbox("glyph", "Grok Glyph Again");
    await mcpCall(again.accessToken, "list_messages", {});
  });

  it("makes a re-enabled bot sign in and connect again", async () => {
    const apiKey = await rotateBotKey(env, "alexandria");
    const connected = await connectMailbox("alexandria", "Grok Alexandria");
    await mcpCall(connected.accessToken, "list_messages", {});

    await updateBot(env, "alexandria", { enabled: false });
    await updateBot(env, "alexandria", { enabled: true });

    await expect(mcpCall(connected.accessToken, "list_messages", {})).rejects.toThrow(/401/);
    await expect(refresh(connected.refreshToken, connected.clientId)).rejects.toThrow(/invalid_grant|400/);
    await expect(mcpCall(apiKey, "list_messages", {})).rejects.toThrow(/401/);

    const again = await connectMailbox("alexandria", "Grok Alexandria Again");
    await mcpCall(again.accessToken, "list_messages", {});
  });

  it("rejects an authorization code approved before the mailbox was disabled", async () => {
    const consent = await beginConsent("Grok Vista");
    const approved = await postMailbox(consent, "vista");
    const code = new URL(redirectFromContinue(await approved.text())).searchParams.get("code");
    expect(code).toBeTruthy();
    // Migration 0017 sets revoked_at and cannot delete the KV grant. Re-enable leaves that stamp.
    const revokedAt = new Date(Date.now() + 2000).toISOString();
    await env.DB.prepare(
      `INSERT INTO oauth_connection (bot_id, grant_id, created_at, revoked_at) VALUES ('vista', 'revoked', ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
    )
      .bind(revokedAt, revokedAt)
      .run();
    await env.DB.prepare(`UPDATE bots SET enabled = 1 WHERE id = 'vista'`).run();
    await expect(
      tokenRequest({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "http://127.0.0.1/callback",
        client_id: consent.clientId,
        code_verifier: consent.verifier,
        resource,
      }),
    ).rejects.toThrow(/invalid_grant|400/);
    const row = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = 'vista'`).first<{
      grant_id: string;
      revoked_at: string | null;
    }>();
    expect(row).toEqual({ grant_id: "revoked", revoked_at: revokedAt });
  });

  it("clears a bot that was already disabled when migration 0017 runs", async () => {
    const { bot: kept } = await createBot(env, { id: "still-on", local: "still-on", displayName: "Still On" });
    const keptHash = (await getBot(env, kept.id))?.api_key_hash;
    expect(keptHash).toBeTruthy();
    await createBot(env, { id: "was-off", local: "was-off", displayName: "Was Off" });
    await createBot(env, { id: "was-bare", local: "was-bare", displayName: "Was Bare" });
    const stamp = "2026-10-01T00:00:00.000Z";
    await env.DB.prepare(
      `UPDATE bots SET enabled = 0, api_key_hash = 'old-hash', webhook_key_ct = 'ct', webhook_key_iv = 'iv' WHERE id = 'was-off'`,
    ).run();
    await env.DB.prepare(`UPDATE bots SET enabled = 0, api_key_hash = 'bare-hash' WHERE id = 'was-bare'`).run();
    await env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, bot_id, message_id, url, status, attempts, payload, created_at, updated_at)
       VALUES ('was-off-delivery', 'was-off', '', 'https://hooks.example.test/was-off', 'pending', 0, '{}', ?, ?)`,
    )
      .bind(stamp, stamp)
      .run();
    await env.DB.prepare(`INSERT INTO oauth_connection (bot_id, grant_id, created_at) VALUES ('was-off', 'live-grant', ?)`).bind(stamp).run();
    await applyDisabledCredentialFix();

    const off = await getBot(env, "was-off");
    expect(off?.enabled).toBe(0);
    expect(off?.api_key_hash).toBeNull();
    expect(off?.webhook_key_ct).toBeNull();
    expect(off?.webhook_key_iv).toBeNull();
    const delivery = await env.DB.prepare(`SELECT status, last_error FROM webhook_deliveries WHERE id = 'was-off-delivery'`).first<{
      status: string;
      last_error: string | null;
    }>();
    expect(delivery).toEqual({ status: "cancelled", last_error: "bot disabled" });
    const connection = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = 'was-off'`).first<{
      grant_id: string;
      revoked_at: string | null;
    }>();
    expect(connection).toEqual({ grant_id: "live-grant", revoked_at: "2026-10-22T00:00:00.000Z" });
    const bare = await env.DB.prepare(`SELECT grant_id, revoked_at FROM oauth_connection WHERE bot_id = 'was-bare'`).first<{
      grant_id: string;
      revoked_at: string | null;
    }>();
    expect(bare).toEqual({ grant_id: "revoked", revoked_at: "2026-10-22T00:00:00.000Z" });
    expect((await getBot(env, "was-bare"))?.api_key_hash).toBeNull();
    expect((await getBot(env, kept.id))?.api_key_hash).toBe(keptHash);
  });

  it("refuses a webhook save while the bot is disabled", async () => {
    await createBot(env, { id: "hookshut", local: "hookshut", displayName: "Hook Shut" });
    const stamp = "2026-10-01T00:00:00.000Z";
    await env.DB.prepare(`INSERT INTO webhook_setup_codes (code_hash, bot_id, expires_at, used_at) VALUES ('hookshut-code', 'hookshut', ?, NULL)`)
      .bind(stamp)
      .run();
    await updateBot(env, "hookshut", { enabled: false });
    await updateBot(env, "hookshut", { enabled: false });
    await expect(setBotWebhook(env, "hookshut", "https://hooks.example.test/hookshut", "hookshut-key")).rejects.toThrow(/disabled/);
    const stored = await getBot(env, "hookshut");
    expect(stored?.enabled).toBe(0);
    expect(stored?.api_key_hash).toBeNull();
    expect(stored?.webhook_key_ct).toBeNull();
    const code = await env.DB.prepare(`SELECT used_at FROM webhook_setup_codes WHERE code_hash = 'hookshut-code'`).first<{ used_at: string | null }>();
    expect(code?.used_at).toBeTruthy();
  });
});

/** Startup already applied 0017 when no bot was disabled. Run that file again against the rows this test just disabled. */
async function applyDisabledCredentialFix(): Promise<void> {
  const migrations = (env as Env & { TEST_MIGRATIONS?: { name: string; queries: string[] }[] }).TEST_MIGRATIONS ?? [];
  const migration = migrations.find((item) => item.name.includes("0017_disabled_bot_credentials.sql"));
  if (!migration) throw new Error(`migrations/0017_disabled_bot_credentials.sql was not loaded (${migrations.map((item) => item.name).join(", ")})`);
  for (const query of migration.queries) {
    const sql = query.trim();
    if (sql) await env.DB.prepare(sql).run();
  }
}

type Consent = {
  clientId: string;
  verifier: string;
  adminPath: string;
  html: string;
  cookies: string;
  handle: string;
};

async function beginConsent(clientName: string, clientId?: string): Promise<Consent> {
  let resolvedClientId = clientId;
  if (!resolvedClientId) {
    const registered = await worker.fetch(
      new Request(`${origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: ["http://127.0.0.1/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }),
      env,
    );
    if (registered.status !== 201 && registered.status !== 200) throw new Error(`register ${registered.status}: ${await registered.text()}`);
    resolvedClientId = ((await registered.json()) as { client_id: string }).client_id;
  }
  const verifier = base64UrlBytes(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlBytes(new Uint8Array(digest));
  const redirectUri = "http://127.0.0.1/callback";
  const query = new URLSearchParams({
    response_type: "code",
    client_id: resolvedClientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "oauth-state",
    scope: "mailbox",
    resource,
  });
  const start = await worker.fetch(new Request(`${origin}/oauth/authorize?${query}`), env);
  if (start.status !== 302) throw new Error(`authorize redirect ${start.status}`);
  const adminUrl = new URL(start.headers.get("location") || "");
  const page = await worker.fetch(await adminRequest(`${adminUrl.pathname}${adminUrl.search}`), env);
  const html = await page.text();
  if (page.status !== 200 || !html.includes("Connect a Grok Bot to BotMail")) throw new Error(`consent ${page.status}: ${html.slice(0, 240)}`);
  expect(html).toContain("Create a new mailbox");
  expect(html).toContain('role="combobox"');
  expect(html).toContain('name="mailbox"');
  expect(html).toContain('name="notes"');
  expect(html).toContain("Mailboxes already connected to a bot are hidden. To reconnect one, revoke it on its BotMail page first.");
  const csp = page.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("script-src 'unsafe-inline'");
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(html).toContain(`nonce="${nonce}"`);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("consent handle missing");
  const cookies = (typeof page.headers.getSetCookie === "function" ? page.headers.getSetCookie() : [page.headers.get("set-cookie") ?? ""])
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
  return { clientId: resolvedClientId, verifier, adminPath: `${adminUrl.pathname}${adminUrl.search}`, html, cookies, handle };
}

function redirectFromContinue(html: string): string {
  const raw = /<a href="([^"]+)"/.exec(html)?.[1];
  if (!raw) throw new Error(`no continue link: ${html.slice(0, 240)}`);
  return raw.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

async function postMailbox(consent: Consent, botId: string): Promise<Response> {
  return worker.fetch(
    await adminRequest(consent.adminPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: consent.cookies },
      body: new URLSearchParams({ handle: consent.handle, mailbox: botId, decision: "approve" }),
    }),
    env,
  );
}

async function connectMailbox(botId: string, clientName: string): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const consent = await beginConsent(clientName);
  const approved = await postMailbox(consent, botId);
  const approvedHtml = await approved.text();
  if (approved.status !== 200) throw new Error(`approve ${approved.status}: ${approvedHtml.slice(0, 240)}`);
  const redirectUri = "http://127.0.0.1/callback";
  const client = { client_id: consent.clientId };
  const verifier = consent.verifier;
  const back = new URL(redirectFromContinue(approvedHtml));
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`no code: ${back}`);
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource,
  });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId: client.client_id };
}

async function refresh(refreshToken: string, clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

async function tokenRequest(fields: Record<string, string>): Promise<{ access_token: string; refresh_token: string }> {
  const response = await worker.fetch(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
    env,
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text) as { access_token: string; refresh_token: string };
}
