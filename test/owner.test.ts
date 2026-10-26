import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { verifiedOwnerEmail } from "../src/auth";
import { createBot, getBot } from "../src/db";
import worker from "../src/index";
import { ACCESS_EMAIL, adminRequest, base64UrlBytes, mcpCall } from "./helpers";

const origin = `https://${env.PUBLIC_HOST}`;
const resource = `${origin}/mcp`;
const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };

describe("mailbox owner", () => {
  it("sets the owner from a verified Access identity and stores null when that identity cannot be verified", async () => {
    const created = await worker.fetch(
      await adminRequest("/admin/api/bots", {
        method: "POST",
        headers: { ...headers, "cf-access-authenticated-user-email": "eve@example.com" },
        body: JSON.stringify({ local_part: "owned" }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "owned", owner_email: ACCESS_EMAIL, notes: "" });

    const forged = await adminRequest(
      "/admin/api/bots",
      {
        method: "POST",
        headers: { ...headers, "cf-access-authenticated-user-email": "eve@example.com" },
        body: JSON.stringify({ local_part: "nope" }),
      },
      { jwt: "not-a-jwt" },
    );
    const owner = await verifiedOwnerEmail(forged, env);
    expect(owner).toBeNull();
    const blocked = await worker.fetch(forged, env);
    expect(blocked.status).toBe(401);
    expect(await getBot(env, "nope")).toBeNull();

    const unowned = await createBot(env, { local: "forged", ownerEmail: owner });
    expect(unowned.bot.owner_email).toBeNull();
    const viaMcp = (await mcpCall("test-admin-key", "create_bot", { local_part: "scripted" })) as { owner_email: string | null };
    expect(viaMcp.owner_email).toBeNull();
  });

  it("lets an admin edit the owner and rejects a value that is not an email", async () => {
    const created = await worker.fetch(
      await adminRequest("/admin/api/bots", {
        method: "POST",
        headers,
        body: JSON.stringify({ local_part: "editable" }),
      }),
      env,
    );
    expect(created.status).toBe(201);

    const saved = await worker.fetch(
      await adminRequest("/admin/api/bots/editable", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ owner_email: "  Sam@Example.com " }),
      }),
      env,
    );
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { bot: { owner_email: string } }).bot.owner_email).toBe("sam@example.com");

    const rejected = await worker.fetch(
      await adminRequest("/admin/api/bots/editable", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ owner_email: "not-an-email" }),
      }),
      env,
    );
    expect(rejected.status).toBe(400);
    const unchanged = await worker.fetch(await adminRequest("/admin/api/bots/editable"), env);
    expect(((await unchanged.json()) as { bot: { owner_email: string } }).bot.owner_email).toBe("sam@example.com");

    const cleared = await worker.fetch(
      await adminRequest("/admin/api/bots/editable", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ owner_email: "" }),
      }),
      env,
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { bot: { owner_email: string | null } }).bot.owner_email).toBeNull();
  });

  it("makes the connect note optional, records the owner on create, and leaves an existing mailbox owner unchanged", async () => {
    const consent = await beginConsent("Owner create");
    expect(consent.html).toContain('id="mode-existing" value="existing" checked');
    expect(consent.html).toContain('id="mode-new" value="new"');
    expect(consent.html).toContain("#mode-new:checked ~ .panel-new{display:block}");
    expect(consent.html).toContain("#mode-new:checked ~ .panel-existing{display:none}");
    expect(consent.html).toContain(">Optional<");
    expect(consent.html).not.toContain('value="__new__"');
    expect(consent.html).not.toContain("Notes are required");

    const created = await postConsent(consent, {
      mode: "new",
      local_part: "freshbox",
      display_name: "Freshbox",
      decision: "approve",
    });
    const createdHtml = await created.text();
    expect(created.status, createdHtml.slice(0, 240)).toBe(200);
    const fresh = await getBot(env, "freshbox");
    expect(fresh?.owner_email).toBe(ACCESS_EMAIL);
    expect(fresh?.notes).toBe("");

    await env.DB.prepare(`UPDATE bots SET owner_email = ? WHERE id = 'quill'`).bind("kept@example.com").run();
    const before = await getBot(env, "quill");
    const again = await beginConsent("Owner existing");
    const connected = await postConsent(again, {
      mode: "existing",
      mailbox: "quill",
      local_part: "should-ignore",
      notes: "should-ignore",
      decision: "approve",
    });
    const connectedHtml = await connected.text();
    expect(connected.status, connectedHtml.slice(0, 240)).toBe(200);
    const after = await getBot(env, "quill");
    expect(after?.owner_email).toBe("kept@example.com");
    expect(after?.notes).toBe(before?.notes);
    expect(after?.address_local).toBe(before?.address_local);
    expect(await getBot(env, "should-ignore")).toBeNull();
  });
});

async function beginConsent(clientName: string): Promise<{ adminPath: string; html: string; cookies: string; handle: string }> {
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
  if (registered.status !== 201 && registered.status !== 200) throw new Error(`register ${registered.status}`);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  const verifier = base64UrlBytes(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1/callback",
    code_challenge: base64UrlBytes(new Uint8Array(digest)),
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
  if (page.status !== 200) throw new Error(`consent ${page.status}: ${html.slice(0, 240)}`);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("consent handle missing");
  const cookies = (typeof page.headers.getSetCookie === "function" ? page.headers.getSetCookie() : [page.headers.get("set-cookie") ?? ""])
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
  return { adminPath: `${adminUrl.pathname}${adminUrl.search}`, html, cookies, handle };
}

async function postConsent(consent: { adminPath: string; cookies: string; handle: string }, fields: Record<string, string>): Promise<Response> {
  return worker.fetch(
    await adminRequest(consent.adminPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: consent.cookies },
      body: new URLSearchParams({ handle: consent.handle, ...fields }),
    }),
    env,
  );
}
