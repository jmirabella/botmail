import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { setAccessCertsFetch } from "../src/auth";
import worker from "../src/index";
import { ACCESS_EMAIL, accessJwt, adminRequest, mcpCall } from "./helpers";

type AccessEnv = Env & { CF_ACCESS_TEAM_DOMAIN: string; CF_ACCESS_AUD: string };
const mutable = env as AccessEnv;
const team = env.CF_ACCESS_TEAM_DOMAIN;
const aud = env.CF_ACCESS_AUD;

afterEach(() => {
  setAccessCertsFetch(null);
  mutable.CF_ACCESS_TEAM_DOMAIN = team;
  mutable.CF_ACCESS_AUD = aud;
});

async function status(path: string, jwt: string | null, init: RequestInit = {}): Promise<number> {
  return (await worker.fetch(await adminRequest(path, init, { jwt }), env)).status;
}

describe("Cloudflare Access is the only lock on the dashboard API", () => {
  it("returns the signed-in email and rejects bad audience, expiry, signature, issuer, and email domain", async () => {
    const valid = await accessJwt();
    const session = await worker.fetch(await adminRequest("/admin/api/session", {}, { jwt: valid }), env);
    expect(session.status).toBe(200);
    const body = (await session.json()) as { email: string; mail_domain: string };
    expect(body.email).toBe(ACCESS_EMAIL);
    expect(body.mail_domain).toBe("bots.example.test");

    expect(await status("/admin/api/bots", await accessJwt({ aud: "other-aud" }))).toBe(401);
    expect(await status("/admin/api/bots", await accessJwt({ exp: Math.floor(Date.now() / 1000) - 60 }))).toBe(401);
    expect(await status("/admin/api/bots", `${valid.slice(0, -4)}aaaa`)).toBe(401);
    expect(await status("/admin/api/bots", await accessJwt({ iss: "https://evil.cloudflareaccess.com" }))).toBe(401);
    expect(await status("/admin/api/bots", await accessJwt({ email: "ada@other.test" }))).toBe(401);
    expect(await status("/admin/api/bots", null)).toBe(401);
  });

  it("does not accept the admin API key in the browser path", async () => {
    const keyOnly = await worker.fetch(await adminRequest("/admin/api/bots", { headers: { authorization: "Bearer test-admin-key" } }, { jwt: null }), env);
    expect(keyOnly.status).toBe(401);
    expect(await keyOnly.json()).toEqual({ error: "Cloudflare Access required" });

    const keyMutation = await status("/admin/api/bots", null, {
      method: "POST",
      headers: { authorization: "Bearer test-admin-key", "x-bot-mail-action": "1", "content-type": "application/json" },
      body: JSON.stringify({ id: "intruder" }),
    });
    expect(keyMutation).toBe(401);
    expect(await env.DB.prepare(`SELECT id FROM bots WHERE id = 'intruder'`).first()).toBeNull();

    const jwtWithJunkKey = await worker.fetch(await adminRequest("/admin/api/bots", { headers: { authorization: "Bearer nope" } }), env);
    expect(jwtWithJunkKey.status).toBe(200);
  });

  it("keeps the admin key for the admin MCP path, and a JWT alone does not open MCP", async () => {
    const created = (await mcpCall("test-admin-key", "create_bot", { id: "scripted", display_name: "Scripted" })) as { apiKey: string };
    expect(created.apiKey.startsWith("bm_scripted_")).toBe(true);

    const jwtOnly = await worker.fetch(
      new Request(`https://${env.PUBLIC_HOST}/mcp`, {
        method: "POST",
        headers: {
          "cf-access-jwt-assertion": await accessJwt(),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(jwtOnly.status).toBe(401);
  });

  it("requires the mutation header even with a valid Access identity", async () => {
    expect(await status("/admin/api/webhooks/drain", await accessJwt(), { method: "POST" })).toBe(400);
  });
});

describe("Access required page", () => {
  it("renders a clean page for browser routes and assets without a key prompt", async () => {
    for (const path of ["/", "/mail", "/bots/forge", "/settings", "/favicon.svg"]) {
      const response = await worker.fetch(await adminRequest(path, {}, { jwt: null }), env);
      expect(response.status, path).toBe(401);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Access required");
      expect(html).toContain("Cloudflare Access");
      expect(html).not.toMatch(/<input|<form|api key|admin key|bearer/i);
    }
    const expired = await worker.fetch(await adminRequest("/mail", {}, { jwt: await accessJwt({ exp: 1 }) }), env);
    expect(expired.status).toBe(401);
  });

  it("says Access is not configured instead of falling back to a key", async () => {
    mutable.CF_ACCESS_AUD = "";
    const response = await worker.fetch(await adminRequest("/mail"), env);
    expect(response.status).toBe(401);
    const html = await response.text();
    expect(html).toContain("not configured");
    expect(html).not.toMatch(/<input|api key|bearer/i);
    expect(await status("/admin/api/session", await accessJwt())).toBe(401);
  });
});
