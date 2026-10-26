import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { getBot, getBotByKeyHash } from "../src/db";
import worker from "../src/index";
import { adminRequest, deliver, mcpCall, rawMime } from "./helpers";

const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };
const CLOUDFLARE_RECEIVED = "Received: from bg-bbi.cloudflare-smtp.net by cloudflare-email.net id test";

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

describe("mailbox aliases", () => {
  it("rejects an address that is already a mailbox or an alias, including a disabled mailbox", async () => {
    const quill = await getBot(env, "quill");
    const domain = quill?.domain ?? "";
    const aliasOfMailbox = await api("/admin/api/routes", "POST", { kind: "alias", local_part: "Quill", targets: ["eggbot"] });
    expect(aliasOfMailbox.status).toBe(409);
    expect(((await aliasOfMailbox.json()) as { error: string }).error).toContain(`quill@${domain} is already the mailbox`);

    const created = await api("/admin/api/routes", "POST", { kind: "alias", local_part: "support", targets: ["quill"] });
    expect(created.status).toBe(201);
    const mailboxOfAlias = await api("/admin/api/bots", "POST", { local_part: "Support" });
    expect(mailboxOfAlias.status).toBe(409);
    expect(((await mailboxOfAlias.json()) as { error: string }).error).toContain("already an alias");

    const pager = await api("/admin/api/bots", "POST", { id: "pager", local_part: "pager", display_name: "Pager" });
    expect(pager.status).toBe(201);
    const disabled = await api("/admin/api/bots/pager", "PATCH", { enabled: false });
    expect(disabled.status).toBe(200);
    const aliasOfDisabled = await api("/admin/api/routes", "POST", { kind: "alias", local_part: "pager", targets: ["quill"] });
    expect(aliasOfDisabled.status).toBe(409);
    expect(((await aliasOfDisabled.json()) as { error: string }).error).toContain("disabled");

    await expect(
      env.DB.prepare(`INSERT INTO address_registry (address, kind, owner_id, created_at) VALUES (?, 'alias', 'other', ?)`)
        .bind(`quill@${domain}`, "2026-10-23T00:00:00.000Z")
        .run(),
    ).rejects.toThrow(/unique/i);
  });

  it("delivers a separate copy to each alias target and records the alias", async () => {
    const quill = await getBot(env, "quill");
    const domain = quill?.domain ?? "";
    const created = await api("/admin/api/routes", "POST", { kind: "alias", local_part: "desk", targets: ["quill", "eggbot"] });
    expect(created.status).toBe(201);
    const messageId = "<alias-desk@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `desk@${domain}`, subject: "Desk copy", text: "both", messageId }),
      "ada@example.com",
      `desk@${domain}`,
    );
    const rows = await env.DB.prepare(`SELECT bot_id, folder, via_alias FROM messages WHERE message_id_header = ? ORDER BY bot_id`)
      .bind(messageId)
      .all<{ bot_id: string; folder: string; via_alias: string | null }>();
    expect(rows.results).toEqual([
      { bot_id: "eggbot", folder: "inbox", via_alias: `desk@${domain}` },
      { bot_id: "quill", folder: "inbox", via_alias: `desk@${domain}` },
    ]);

    const routeId = ((await created.json()) as { route: { id: string } }).route.id;
    expect((await api(`/admin/api/routes/${routeId}`, "DELETE")).status).toBe(200);
    const again = "<alias-desk-stopped@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `desk@${domain}`, subject: "Stopped", text: "unrouted", messageId: again }),
      "ada@example.com",
      `desk@${domain}`,
    );
    const stopped = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`).bind(again).all<{ bot_id: string; folder: string }>();
    expect(stopped.results).toEqual([{ bot_id: "_unrouted", folder: "_unrouted" }]);
  });

  it("renames a mailbox, keeps the connector on the same id, and delivers the old address as an alias", async () => {
    const before = await getBot(env, "argus");
    if (!before) throw new Error("argus missing");
    const domain = before.domain;
    const token = "bm_argus_connection";
    const hash = await sha256Hex(token);
    await env.DB.prepare(`UPDATE bots SET api_key_hash = ?, webhook_url = ? WHERE id = 'argus'`).bind(hash, "https://hooks.example.test/argus").run();
    await env.DB.prepare(`INSERT INTO oauth_connection (bot_id, grant_id, created_at) VALUES ('argus', 'grant-argus', ?)`).bind(before.created_at).run();
    const beforeIds = await env.DB.prepare(`SELECT id FROM messages WHERE bot_id = 'argus'`).all<{ id: string }>();

    const renamed = await api("/admin/api/bots/argus", "PATCH", { address_local: "armstrong" });
    expect(renamed.status).toBe(200);
    const body = (await renamed.json()) as { bot: { id: string; address: string; address_local: string } };
    expect(body.bot.id).toBe("argus");
    expect(body.bot.address_local).toBe("armstrong");
    expect(body.bot.address).toBe(`armstrong@${domain}`);

    const after = await getBot(env, "argus");
    expect(after?.api_key_hash).toBe(hash);
    expect(after?.webhook_url).toBe("https://hooks.example.test/argus");
    expect(after?.domain).toBe(domain);
    const connected = await getBotByKeyHash(env, hash);
    expect(connected?.id).toBe("argus");
    expect(connected?.address_local).toBe("armstrong");
    const oauth = await env.DB.prepare(`SELECT bot_id, grant_id, revoked_at FROM oauth_connection WHERE bot_id = 'argus'`).first<{
      bot_id: string;
      grant_id: string;
      revoked_at: string | null;
    }>();
    expect(oauth).toEqual({ bot_id: "argus", grant_id: "grant-argus", revoked_at: null });
    const afterIds = await env.DB.prepare(`SELECT id FROM messages WHERE bot_id = 'argus'`).all<{ id: string }>();
    expect(afterIds.results).toEqual(beforeIds.results);

    const oldId = "<rename-old-argus@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `argus@${domain}`, subject: "Old address", text: "still here", messageId: oldId }),
      "ada@example.com",
      `argus@${domain}`,
    );
    const oldRow = await env.DB.prepare(`SELECT bot_id, folder, via_alias FROM messages WHERE message_id_header = ?`)
      .bind(oldId)
      .first<{ bot_id: string; folder: string; via_alias: string | null }>();
    expect(oldRow).toEqual({ bot_id: "argus", folder: "inbox", via_alias: `argus@${domain}` });

    const newId = "<rename-new-armstrong@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `armstrong@${domain}`, subject: "New address", text: "primary", messageId: newId }),
      "ada@example.com",
      `armstrong@${domain}`,
    );
    const newRow = await env.DB.prepare(`SELECT bot_id, folder, via_alias FROM messages WHERE message_id_header = ?`)
      .bind(newId)
      .first<{ bot_id: string; folder: string; via_alias: string | null }>();
    expect(newRow).toEqual({ bot_id: "argus", folder: "inbox", via_alias: null });
  });

  it("lets a bot send from an alias that targets it and rejects any other alias", async () => {
    const quill = await getBot(env, "quill");
    const domain = quill?.domain ?? "";
    expect((await api("/admin/api/routes", "POST", { kind: "alias", local_part: "billing", targets: ["quill"] })).status).toBe(201);
    const { rotateBotKey } = await import("../src/db");
    const quillKey = await rotateBotKey(env, "quill");
    const forgeKey = await rotateBotKey(env, "forge");
    const sent = (await mcpCall(quillKey, "send_email", {
      from: `billing@${domain}`,
      to: [`forge@${domain}`],
      subject: "From billing",
      text: "alias sender",
    })) as { status: string; message_id: string };
    expect(sent.status).toBe("sent");
    const row = await env.DB.prepare(`SELECT from_addr, bot_id FROM messages WHERE id = ?`).bind(sent.message_id).first<{ from_addr: string; bot_id: string }>();
    expect(row).toEqual({ from_addr: `billing@${domain}`, bot_id: "quill" });
    await expect(
      mcpCall(forgeKey, "send_email", {
        from: `billing@${domain}`,
        to: [`quill@${domain}`],
        subject: "Not allowed",
        text: "no",
      }),
    ).rejects.toThrow(/does not deliver to this mailbox/);
  });

  it("forwards new mail when a mailbox is disabled, and does not chain or forward junk", async () => {
    const egg = await getBot(env, "eggbot");
    const domain = egg?.domain ?? "";
    expect((await api("/admin/api/bots/eggbot", "PATCH", { enabled: false, forward_to: "quill" })).status).toBe(200);

    const kept = "<forward-disable@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `eggbot@${domain}`, subject: "While off", text: "copy", messageId: kept }),
      "ada@example.com",
      `eggbot@${domain}`,
    );
    const copies = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ? ORDER BY bot_id`)
      .bind(kept)
      .all<{ bot_id: string; folder: string }>();
    expect(copies.results).toEqual([
      { bot_id: "eggbot", folder: "inbox" },
      { bot_id: "quill", folder: "inbox" },
    ]);

    const junkId = "<forward-junk@bots.example.test>";
    const mime = rawMime({ from: "ada@example.com", to: `eggbot@${domain}`, subject: "Spammy", text: "no copy", messageId: junkId });
    await deliver(`${CLOUDFLARE_RECEIVED}\r\nX-CF-SpamH-Score: 5\r\n${mime}`, "ada@example.com", `eggbot@${domain}`);
    const junk = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`).bind(junkId).all<{ bot_id: string; folder: string }>();
    expect(junk.results).toEqual([{ bot_id: "eggbot", folder: "junk" }]);

    expect((await api("/admin/api/bots/quill", "PATCH", { enabled: false, forward_to: "forge" })).status).toBe(200);
    const chained = "<forward-chain@bots.example.test>";
    await deliver(
      rawMime({ from: "ada@example.com", to: `eggbot@${domain}`, subject: "No chain", text: "stay", messageId: chained }),
      "ada@example.com",
      `eggbot@${domain}`,
    );
    const stayed = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`)
      .bind(chained)
      .all<{ bot_id: string; folder: string }>();
    expect(stayed.results).toEqual([{ bot_id: "eggbot", folder: "inbox" }]);
  });

});
