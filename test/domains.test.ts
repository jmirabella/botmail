import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createBot, getBot } from "../src/db";
import { ensureDomains, setDomainFetch } from "../src/domains";
import { processInboundEmail } from "../src/inbound";
import worker from "../src/index";
import { adminRequest, inboundMessage, mcpCall, rawMime } from "./helpers";

const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };
const DEFAULT = env.MAIL_DOMAIN;
const MGA = "bot.mga.test";

type Call = { method: string; path: string; body: unknown };

type FakeOptions = {
  zones?: Array<{ id: string; name: string; account: { id: string } }>;
  routingEnabled?: boolean;
  catchAll?: { enabled: boolean; actions: Array<{ type: string; value?: string[] }> };
  sending?: Array<{ name: string; enabled: boolean }>;
  dns?: Record<string, string[]>;
};

/** Cloudflare API plus DNS-over-HTTPS, recording every API call. */
function fakeCloudflare(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const dns = options.dns ?? {};
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "cloudflare-dns.com") {
      const key = `${url.searchParams.get("name")}|${url.searchParams.get("type")}`;
      return Response.json({ Answer: (dns[key] ?? []).map((data) => ({ data })) });
    }
    const path = `${url.pathname.replace("/client/v4", "")}${url.search}`;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    if (path.startsWith("/zones?")) {
      const name = url.searchParams.get("name");
      return ok((options.zones ?? []).filter((zone) => zone.name === name));
    }
    if (method === "GET" && path.endsWith("/email/routing")) return ok({ enabled: options.routingEnabled ?? false });
    if (method === "GET" && path.endsWith("/rules/catch_all")) {
      return ok(options.catchAll ?? { enabled: false, actions: [{ type: "drop", value: [] }] });
    }
    if (method === "GET" && path.endsWith("/email/sending/subdomains")) return ok(options.sending ?? []);
    return ok({});
  }) as typeof fetch;
  return { fake, calls };
}

const mgaZone = { id: "zone-mga", name: "mga.test", account: { id: "acct-1" } };
const mgaDns = {
  [`${MGA}|MX`]: ["10 route1.mx.cloudflare.net."],
  [`cf-bounce.${MGA}|MX`]: ["10 cf-bounce.mx.cloudflare.net."],
  [`cf-bounce.${MGA}|TXT`]: ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
  [`cf-bounce._domainkey.${MGA}|TXT`]: ['"v=DKIM1; p=abc"'],
  [`_dmarc.${MGA}|TXT`]: ['"v=DMARC1; p=reject"'],
};

function withApi(extra: Partial<Env> = {}): Env {
  return { ...env, CF_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct-1", WORKER_NAME: "bot-mail", ...extra } as Env;
}

async function api(path: string, init: RequestInit = {}, target: Env = env): Promise<Response> {
  return worker.fetch(await adminRequest(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }), target);
}

async function addManualDomain(domain = MGA): Promise<void> {
  setDomainFetch(fakeCloudflare({ dns: mgaDns }).fake);
  const response = await api("/admin/api/domains", { method: "POST", body: JSON.stringify({ domain }) });
  expect(response.status).toBe(201);
}

const GROUP_IDS = ["_unrouted", "forge", "vespa", "post", "glyph", "alexandria", "athena", "argus", "vista", "aegis", "quill", "eggbot"];

afterEach(async () => {
  setDomainFetch(null);
  const keep = GROUP_IDS.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages`),
    env.DB.prepare(`DELETE FROM alias_targets WHERE route_id IN (SELECT id FROM routes)`),
    // Fixture reset only. The Worker never deletes address_registry rows.
    env.DB.prepare(`DELETE FROM address_registry WHERE kind != 'mailbox' OR owner_id NOT IN (${keep})`).bind(...GROUP_IDS),
    env.DB.prepare(`DELETE FROM routes`),
    env.DB.prepare(`DELETE FROM bots WHERE id NOT IN (${keep})`).bind(...GROUP_IDS),
    env.DB.prepare(`DELETE FROM mail_domains WHERE is_default = 0`),
    env.DB.prepare(`UPDATE settings SET value = '' WHERE key = 'unique_bot_names'`),
  ]);
});

describe("mail domains, notes, and unique addresses", () => {
  it("migration 0004 moves pre-domain bots and routes onto MAIL_DOMAIN and indexes addresses", async () => {
    expect((await getBot(env, "forge"))?.domain).toBe(DEFAULT);
    const stamp = "2026-10-09T00:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO bots (id, display_name, address_local, enabled, created_at, updated_at) VALUES ('legacy', 'Legacy', 'legacy', 1, ?, ?)`).bind(stamp, stamp),
      env.DB.prepare(`INSERT INTO routes (id, kind, local_part, target, enabled, created_at, updated_at) VALUES ('r1', 'alias', 'old', 'legacy', 1, ?, ?)`).bind(stamp, stamp),
    ]);
    await ensureDomains(env);
    expect((await getBot(env, "legacy"))?.domain).toBe(DEFAULT);
    expect(await env.DB.prepare(`SELECT domain FROM routes WHERE id = 'r1'`).first()).toEqual({ domain: DEFAULT });
    expect((await env.DB.prepare(`SELECT domain, is_default FROM mail_domains`).all()).results).toEqual([{ domain: DEFAULT, is_default: 1 }]);
    await expect(
      env.DB.prepare(`INSERT INTO bots (id, display_name, address_local, domain, enabled, created_at, updated_at) VALUES ('forge2', 'F', 'forge', ?, 1, ?, ?)`)
        .bind(DEFAULT, stamp, stamp)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("adds a domain through the Worker's API token, or returns manual steps without one", async () => {
    const cloudflare = fakeCloudflare({ zones: [mgaZone], dns: mgaDns });
    setDomainFetch(cloudflare.fake);
    const response = await api("/admin/api/domains", { method: "POST", body: JSON.stringify({ domain: MGA }) }, withApi());
    expect(response.status).toBe(201);
    const { domain } = (await response.json()) as { domain: Record<string, unknown> };
    expect(domain).toMatchObject({ mode: "api", zone_name: "mga.test", routing: "ok", sending: "ok", dns: "ok" });
    expect(cloudflare.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /zones/zone-mga/email/routing/enable",
      "PATCH /zones/zone-mga/email/routing",
      "POST /zones/zone-mga/email/routing/dns",
      "PUT /zones/zone-mga/email/routing/rules/catch_all",
      "POST /zones/zone-mga/email/sending/subdomains",
    ]);

    setDomainFetch(fakeCloudflare({ zones: [{ id: "z9", name: "other.test", account: { id: "someone-else" } }] }).fake);
    const foreign = await api("/admin/api/domains", { method: "POST", body: JSON.stringify({ domain: "bot.other.test" }) }, withApi());
    expect(await foreign.json()).toMatchObject({ code: "zone_not_found" });

    setDomainFetch(fakeCloudflare().fake);
    const manual = await api("/admin/api/domains", { method: "POST", body: JSON.stringify({ domain: "bot.third.test" }) });
    const view = ((await manual.json()) as { domain: Record<string, unknown> & { manual_steps: string[] } }).domain;
    expect(view).toMatchObject({ mode: "manual", routing: "manual", sending: "manual" });
    expect(view.manual_steps.join("\n")).toContain("Onboard Domain → bot.third.test");
  });

  it("routes inbound by full address and sends from the bot's own domain", async () => {
    await addManualDomain();
    await env.DB.prepare(`UPDATE settings SET value = 'false' WHERE key = 'unique_bot_names'`).run();
    const mga = await createBot(env, { local: "forge", domain: MGA });
    expect(mga.bot.id).toBe("forge.mga");
    const incoming = inboundMessage(rawMime({ from: "ada@example.com", to: `forge@${MGA}`, subject: "hi", text: "hi", messageId: "<m1@example.com>" }), "ada@example.com", `forge@${MGA}`);
    await processInboundEmail(incoming.message, env);
    expect(await env.DB.prepare(`SELECT bot_id FROM messages WHERE message_id_header = '<m1@example.com>'`).first()).toEqual({ bot_id: "forge.mga" });

    const sent = (await mcpCall(mga.apiKey, "send_email", { to: [`vespa@${DEFAULT}`], subject: "x", text: "y" })) as { status: string; message_id: string };
    expect(sent.status).toBe("sent");
    expect(await env.DB.prepare(`SELECT from_addr FROM messages WHERE id = ?`).bind(sent.message_id).first()).toEqual({ from_addr: `forge@${MGA}` });

    await env.DB.prepare(`UPDATE mail_domains SET enabled = 0 WHERE domain = ?`).bind(MGA).run();
    const blocked = inboundMessage(rawMime({ from: "ada@example.com", to: `forge@${MGA}`, subject: "hi", text: "hi", messageId: "<m2@example.com>" }), "ada@example.com", `forge@${MGA}`);
    await processInboundEmail(blocked.message, env);
    expect(blocked.rejected()).toBe("Recipient domain is not a BotMail domain");
  });

  it("returns a friendly 409 for a taken address and for a repeated name while uniqueBotNames is on", async () => {
    await addManualDomain();
    const taken = await api("/admin/api/bots", { method: "POST", body: JSON.stringify({ local_part: "forge" }) });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "address_taken", error: `forge@${DEFAULT} is already taken by Forge (forge)` });

    const named = await api("/admin/api/bots", { method: "POST", body: JSON.stringify({ local_part: "forge", domain: MGA }) });
    expect(named.status).toBe(409);
    expect(await named.json()).toMatchObject({ code: "name_taken", conflict: { address: `forge@${DEFAULT}` } });

    await api("/admin/api/settings", { method: "PUT", body: JSON.stringify({ unique_bot_names: false }) });
    const allowed = await api("/admin/api/bots", { method: "POST", body: JSON.stringify({ local_part: "forge", domain: MGA }) });
    expect(await allowed.json()).toMatchObject({ id: "forge.mga", address: `forge@${MGA}` });
    const relock = await api("/admin/api/settings", { method: "PUT", body: JSON.stringify({ unique_bot_names: true }) });
    expect(await relock.json()).toMatchObject({ code: "duplicates" });
  });

  it("stores notes from the dashboard and the admin MCP tools", async () => {
    const created = await api("/admin/api/bots", { method: "POST", body: JSON.stringify({ local_part: "intake", notes: "  Owner: Dana. Triages FNOL.  " }) });
    expect(await created.json()).toMatchObject({ notes: "Owner: Dana. Triages FNOL." });
    const patched = await api("/admin/api/bots/intake", { method: "PATCH", body: JSON.stringify({ notes: "Owner: Dana" }) });
    expect(((await patched.json()) as { bot: { notes: string } }).bot.notes).toBe("Owner: Dana");

    const viaMcp = (await mcpCall("test-admin-key", "create_bot", { local_part: "claims", notes: "Owner: ops" })) as Record<string, unknown>;
    expect(viaMcp).toMatchObject({ id: "claims", notes: "Owner: ops" });
    expect(viaMcp).not.toHaveProperty("api_key_hash");
    const updated = (await mcpCall("test-admin-key", "update_bot", { bot: "claims", notes: "Owner: ops. FNOL." })) as Record<string, unknown>;
    expect(updated.notes).toBe("Owner: ops. FNOL.");
  });
});
