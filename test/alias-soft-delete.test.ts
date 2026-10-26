import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { refuseAddressRegistryDelete } from "../src/address-registry";
import { getBot } from "../src/db";
import worker from "../src/index";
import { adminRequest, deliver, rawMime } from "./helpers";

const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };

async function api(path: string, method: string, body?: unknown): Promise<Response> {
  return worker.fetch(
    await adminRequest(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

type TargetRow = { bot_id: string; created_at: string; removed_at: string | null };

describe("alias and address registry soft delete", () => {
  it("marks a dropped alias target removed and restores that same row when it is added back", async () => {
    const quill = await getBot(env, "quill");
    const domain = quill?.domain ?? "";
    const created = await api("/admin/api/routes", "POST", { kind: "alias", local_part: "fanout", targets: ["quill", "eggbot"] });
    expect(created.status).toBe(201);
    const routeId = ((await created.json()) as { route: { id: string } }).route.id;

    const before = await env.DB.prepare(`SELECT bot_id, created_at, removed_at FROM alias_targets WHERE route_id = ? ORDER BY bot_id`)
      .bind(routeId)
      .all<TargetRow>();
    expect(before.results.map((row) => row.removed_at)).toEqual([null, null]);

    const dropped = await api(`/admin/api/routes/${routeId}`, "PATCH", { targets: ["quill"] });
    expect(dropped.status).toBe(200);
    expect(((await dropped.json()) as { route: { targets: string[] } }).route.targets).toEqual(["quill"]);

    const listed = await api("/admin/api/routes", "GET");
    const routes = ((await listed.json()) as { routes: Array<{ id: string; targets: string[] }> }).routes;
    expect(routes.find((route) => route.id === routeId)?.targets).toEqual(["quill"]);

    const afterDrop = await env.DB.prepare(`SELECT bot_id, created_at, removed_at FROM alias_targets WHERE route_id = ? ORDER BY bot_id`)
      .bind(routeId)
      .all<TargetRow>();
    const droppedEgg = afterDrop.results.find((row) => row.bot_id === "eggbot");
    const keptQuill = afterDrop.results.find((row) => row.bot_id === "quill");
    expect(droppedEgg?.removed_at).toBeTruthy();
    expect(droppedEgg?.created_at).toBe(before.results.find((row) => row.bot_id === "eggbot")?.created_at);
    expect(keptQuill?.removed_at).toBeNull();

    const stopped = "<alias-fanout-dropped@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `fanout@${domain}`, subject: "One copy", text: "quill only", messageId: stopped }),
      "ada@example.com",
      `fanout@${domain}`,
    );
    const stoppedRows = await env.DB.prepare(`SELECT bot_id, folder, via_alias FROM messages WHERE message_id_header = ? ORDER BY bot_id`)
      .bind(stopped)
      .all<{ bot_id: string; folder: string; via_alias: string | null }>();
    expect(stoppedRows.results).toEqual([{ bot_id: "quill", folder: "inbox", via_alias: `fanout@${domain}` }]);

    const restored = await api(`/admin/api/routes/${routeId}`, "PATCH", { targets: ["eggbot", "quill"] });
    expect(restored.status).toBe(200);
    const restoredTargets = ((await restored.json()) as { route: { targets: string[] } }).route.targets;
    expect(restoredTargets).toEqual(["eggbot", "quill"]);

    const afterRestore = await env.DB.prepare(`SELECT bot_id, created_at, removed_at FROM alias_targets WHERE route_id = ? ORDER BY bot_id`)
      .bind(routeId)
      .all<TargetRow>();
    expect(afterRestore.results).toEqual([
      { bot_id: "eggbot", created_at: before.results.find((row) => row.bot_id === "eggbot")?.created_at, removed_at: null },
      { bot_id: "quill", created_at: before.results.find((row) => row.bot_id === "quill")?.created_at, removed_at: null },
    ]);

    const again = "<alias-fanout-restored@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `fanout@${domain}`, subject: "Both copies", text: "back", messageId: again }),
      "ada@example.com",
      `fanout@${domain}`,
    );
    const restoredRows = await env.DB.prepare(`SELECT bot_id, folder, via_alias FROM messages WHERE message_id_header = ? ORDER BY bot_id`)
      .bind(again)
      .all<{ bot_id: string; folder: string; via_alias: string | null }>();
    expect(restoredRows.results).toEqual([
      { bot_id: "eggbot", folder: "inbox", via_alias: `fanout@${domain}` },
      { bot_id: "quill", folder: "inbox", via_alias: `fanout@${domain}` },
    ]);
  });

  it("refuses to delete an address registry row", async () => {
    const quill = await getBot(env, "quill");
    if (!quill) throw new Error("quill missing");
    const address = `${quill.address_local}@${quill.domain}`;
    const before = await env.DB.prepare(`SELECT address, kind, owner_id, removed_at FROM address_registry WHERE address = ?`)
      .bind(address)
      .first<{ address: string; kind: string; owner_id: string; removed_at: string | null }>();
    expect(before?.owner_id).toBe("quill");
    expect(before?.removed_at).toBeNull();

    await expect(refuseAddressRegistryDelete(address)).rejects.toThrow(
      `Address registry rows are never deleted. ${address} stays reserved once it is registered.`,
    );

    const after = await env.DB.prepare(`SELECT address, kind, owner_id, removed_at FROM address_registry WHERE address = ?`)
      .bind(address)
      .first();
    expect(after).toEqual(before);
  });

  it("applies migration 0022 on top of 0021", async () => {
    const migrations = (env as Env & { TEST_MIGRATIONS?: { name: string; queries: string[] }[] }).TEST_MIGRATIONS ?? [];
    const names = migrations.map((item) => item.name);
    const prior = names.findIndex((name) => name.includes("0021_mailbox_owner.sql"));
    const next = names.findIndex((name) => name.includes("0022_soft_delete_alias_registry.sql"));
    expect(prior).toBeGreaterThanOrEqual(0);
    expect(next).toBe(prior + 1);
    const statements = (migrations[next]?.queries ?? [])
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("--"));
    expect(statements).toEqual([
      "ALTER TABLE alias_targets ADD COLUMN removed_at TEXT",
      "ALTER TABLE address_registry ADD COLUMN removed_at TEXT",
    ]);

    const applied = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all<{ name: string }>();
    const appliedNames = applied.results.map((row) => row.name);
    const appliedPrior = appliedNames.findIndex((name) => name.includes("0021_mailbox_owner"));
    const appliedNext = appliedNames.findIndex((name) => name.includes("0022_soft_delete_alias_registry"));
    expect(appliedPrior).toBeGreaterThanOrEqual(0);
    expect(appliedNext).toBe(appliedPrior + 1);

    const aliasCols = await env.DB.prepare(`PRAGMA table_info(alias_targets)`).all<{ name: string }>();
    const registryCols = await env.DB.prepare(`PRAGMA table_info(address_registry)`).all<{ name: string }>();
    expect(aliasCols.results.map((col) => col.name)).toContain("removed_at");
    expect(registryCols.results.map((col) => col.name)).toContain("removed_at");
  });
});
