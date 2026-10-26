import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { adminRequest, deliver, mcpCall, rawMime } from "./helpers";

const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };
const OTHER = "other.example.test";
const ANNEX = "annex.example.test";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(await adminRequest(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }), env);
}

async function insertDomain(domain: string): Promise<void> {
  const stamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mail_domains (domain, is_default, enabled, status, checked_at, created_at, updated_at) VALUES (?, 0, 1, '{}', ?, ?, ?)`,
  )
    .bind(domain, stamp, stamp, stamp)
    .run();
}

afterEach(async () => {
  await api("/admin/api/routes/unknown", {
    method: "PUT",
    body: JSON.stringify({ unknown_policy: "unrouted", unknown_bot: "" }),
  });
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE message_id_header IN ('<shelf-kept@bots.example.test>', '<shelf-later@bots.example.test>')`),
    env.DB.prepare(`DELETE FROM routes WHERE domain = ?`).bind(ANNEX),
    env.DB.prepare(`DELETE FROM bots WHERE id IN ('shelf', 'ledger')`),
    env.DB.prepare(`DELETE FROM mail_domains WHERE domain IN (?, ?)`).bind(OTHER, ANNEX),
  ]);
});

describe("soft delete", () => {
  it("archives a bot, keeps its mail, and requires a new key on restore", async () => {
    const created = await api("/admin/api/bots", {
      method: "POST",
      body: JSON.stringify({ local_part: "shelf", display_name: "Shelf", notes: "Owner: stacks" }),
    });
    expect(created.status).toBe(201);
    const minted = (await created.json()) as { id: string; api_key: string; notes: string };
    expect(minted.notes).toBe("Owner: stacks");

    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "shelf@bots.example.test",
        subject: "Shelf kept",
        text: "keep this",
        messageId: "<shelf-kept@bots.example.test>",
      }),
      "ada@example.com",
      "shelf@bots.example.test",
    );
    const kept = await env.DB.prepare(`SELECT id, bot_id, r2_key FROM messages WHERE message_id_header = ?`)
      .bind("<shelf-kept@bots.example.test>")
      .first<{ id: string; bot_id: string; r2_key: string }>();
    expect(kept?.bot_id).toBe("shelf");
    expect(await env.MAIL_BUCKET.get(kept!.r2_key)).toBeTruthy();

    await api("/admin/api/routes/unknown", { method: "PUT", body: JSON.stringify({ unknown_policy: "reject" }) });
    const archived = await api("/admin/api/bots/shelf", { method: "DELETE" });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ archived: "shelf" });
    const row = await env.DB.prepare(`SELECT deleted_at, api_key_hash, enabled, notes FROM bots WHERE id = 'shelf'`).first<{
      deleted_at: string | null;
      api_key_hash: string | null;
      enabled: number;
      notes: string;
    }>();
    expect(row?.deleted_at).toBeTruthy();
    expect(row?.api_key_hash).toBeNull();
    expect(row?.enabled).toBe(0);
    expect(row?.notes).toBe("Owner: stacks");
    await expect(mcpCall(minted.api_key, "list_messages")).rejects.toThrow(/401/);

    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "shelf@bots.example.test",
        subject: "Shelf later",
        text: "hold me",
        messageId: "<shelf-later@bots.example.test>",
      }),
      "ada@example.com",
      "shelf@bots.example.test",
    );
    const later = await env.DB.prepare(`SELECT bot_id FROM messages WHERE message_id_header = ?`)
      .bind("<shelf-later@bots.example.test>")
      .first<{ bot_id: string }>();
    expect(later?.bot_id).toBe("_unrouted");
    expect(await env.MAIL_BUCKET.get(kept!.r2_key)).toBeTruthy();

    const mail = (await (await api("/admin/api/mail?bot=shelf")).json()) as { messages: Array<{ subject: string | null }> };
    expect(mail.messages.some((message) => message.subject === "Shelf kept")).toBe(true);
    const hidden = (await (await api("/admin/api/bots")).json()) as { bots: Array<{ id: string }> };
    expect(hidden.bots.some((bot) => bot.id === "shelf")).toBe(false);
    const shown = (await (await api("/admin/api/bots?include_archived=1")).json()) as { bots: Array<{ id: string; archived: boolean }> };
    expect(shown.bots.find((bot) => bot.id === "shelf")?.archived).toBe(true);

    const restored = await api("/admin/api/bots/shelf/restore", { method: "POST", body: "{}" });
    expect(restored.status).toBe(200);
    const bot = (await restored.json()) as { bot: { id: string; notes: string; archived: boolean; key_configured: boolean } };
    expect(bot.bot).toMatchObject({ id: "shelf", notes: "Owner: stacks", archived: false, key_configured: false });
    const still = (await (await api("/admin/api/mail?bot=shelf")).json()) as { messages: Array<{ subject: string | null }> };
    expect(still.messages.some((message) => message.subject === "Shelf kept")).toBe(true);
    await expect(mcpCall(minted.api_key, "list_messages")).rejects.toThrow(/401/);
    const rotated = (await (await api("/admin/api/bots/shelf/key", { method: "POST", body: "{}" })).json()) as { api_key: string };
    const listed = (await mcpCall(rotated.api_key, "list_messages")) as { messages: unknown[] };
    expect(Array.isArray(listed.messages)).toBe(true);
  });

  it("keeps an archived bot's address and name reserved", async () => {
    const created = await api("/admin/api/bots", {
      method: "POST",
      body: JSON.stringify({ local_part: "ledger", display_name: "Ledger" }),
    });
    expect(created.status).toBe(201);
    expect((await api("/admin/api/bots/ledger", { method: "DELETE" })).status).toBe(200);

    const sameAddress = await api("/admin/api/bots", { method: "POST", body: JSON.stringify({ local_part: "ledger" }) });
    expect(sameAddress.status).toBe(409);
    const addressBody = (await sameAddress.json()) as { error: string; code: string };
    expect(addressBody.code).toBe("archived");
    expect(addressBody.error).toContain("Restore");

    await insertDomain(OTHER);
    const sameName = await api("/admin/api/bots", {
      method: "POST",
      body: JSON.stringify({ local_part: "ledger", domain: OTHER }),
    });
    expect(sameName.status).toBe(409);
    const nameBody = (await sameName.json()) as { error: string; code: string };
    expect(nameBody.code).toBe("archived");
    expect(nameBody.error).toContain("Restore");
    expect(nameBody.error).toContain("ledger");
  });

  it("archives domains and routes without removing the rows", async () => {
    const stamp = new Date().toISOString();
    await env.DB.prepare(`UPDATE mail_domains SET checked_at = COALESCE(checked_at, ?) WHERE is_default = 1`).bind(stamp).run();
    await insertDomain(ANNEX);
    const created = await api("/admin/api/routes", {
      method: "POST",
      body: JSON.stringify({ kind: "alias", local_part: "spare", domain: ANNEX, target: "post" }),
    });
    expect(created.status).toBe(201);
    const route = (await created.json()) as { route: { id: string } };

    expect((await api(`/admin/api/routes/${route.route.id}`, { method: "DELETE" })).status).toBe(200);
    const visible = (await (await api("/admin/api/routes")).json()) as { routes: Array<{ id: string }> };
    expect(visible.routes.some((item) => item.id === route.route.id)).toBe(false);
    const withArchived = (await (await api("/admin/api/routes?include_archived=1")).json()) as {
      routes: Array<{ id: string; deleted_at: string | null }>;
    };
    expect(withArchived.routes.find((item) => item.id === route.route.id)?.deleted_at).toBeTruthy();
    const stored = await env.DB.prepare(`SELECT id FROM routes WHERE id = ?`).bind(route.route.id).first();
    expect(stored).toBeTruthy();

    const clash = await api("/admin/api/routes", {
      method: "POST",
      body: JSON.stringify({ kind: "alias", local_part: "spare", domain: ANNEX, target: "post" }),
    });
    expect(clash.status).toBe(409);
    const clashBody = (await clash.json()) as { error: string };
    expect(clashBody.error).toContain("archived routing rule");
    expect(clashBody.error).toContain("Restore");

    const blocked = await api(`/admin/api/domains/${encodeURIComponent(env.MAIL_DOMAIN)}`, { method: "DELETE" });
    expect(blocked.status).toBe(400);
    expect((await api(`/admin/api/domains/${encodeURIComponent(ANNEX)}`, { method: "DELETE" })).status).toBe(200);
    const domains = (await (await api("/admin/api/domains")).json()) as { domains: Array<{ domain: string }> };
    expect(domains.domains.some((item) => item.domain === ANNEX)).toBe(false);
    const domainRow = await env.DB.prepare(`SELECT deleted_at FROM mail_domains WHERE domain = ?`).bind(ANNEX).first<{ deleted_at: string | null }>();
    expect(domainRow?.deleted_at).toBeTruthy();
    const restoredDomain = await api(`/admin/api/domains/${encodeURIComponent(ANNEX)}/restore`, { method: "POST", body: "{}" });
    expect(restoredDomain.status).toBe(200);
    const restoredRoute = await api(`/admin/api/routes/${route.route.id}/restore`, { method: "POST", body: "{}" });
    expect(restoredRoute.status).toBe(200);
    const back = (await (await api("/admin/api/routes")).json()) as { routes: Array<{ id: string; enabled: number }> };
    expect(back.routes.find((item) => item.id === route.route.id)?.enabled).toBe(1);
  });
});
