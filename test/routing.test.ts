import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { updateBot } from "../src/db";
import { processInboundEmail } from "../src/inbound";
import worker from "../src/index";
import { adminRequest, deliver, inboundMessage, rawMime } from "./helpers";

const adminHeaders = {
  "content-type": "application/json",
  "x-bot-mail-action": "1",
};

describe("routing rules", () => {
  it("sends an alias to the target bot", async () => {
    const created = await worker.fetch(
      await adminRequest("/admin/api/routes", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ kind: "alias", local_part: "support", target: "quill" }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "support@bots.example.test",
        subject: "Alias please",
        text: "route me",
        messageId: "<alias-support@bots.example.test>",
      }),
      "ada@example.com",
      "support@bots.example.test",
    );
    const row = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`)
      .bind("<alias-support@bots.example.test>")
      .first<{ bot_id: string; folder: string }>();
    expect(row).toEqual({ bot_id: "quill", folder: "inbox" });
  });

  it("forwards an external target and keeps a copy", async () => {
    const created = await worker.fetch(
      await adminRequest("/admin/api/routes", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ kind: "forward", local_part: "press", target: "desk@example.com" }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const forwarded: string[] = [];
    const raw = rawMime({
      from: "ada@example.com",
      to: "press@bots.example.test",
      subject: "Please forward",
      text: "outside",
      messageId: "<forward-press@bots.example.test>",
    });
    const incoming = inboundMessage(raw, "ada@example.com", "press@bots.example.test");
    incoming.message.forward = async (rcpt) => {
      forwarded.push(rcpt);
    };
    await processInboundEmail(incoming.message, env);
    expect(forwarded).toEqual(["desk@example.com"]);
    const row = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`)
      .bind("<forward-press@bots.example.test>")
      .first<{ bot_id: string; folder: string }>();
    expect(row).toEqual({ bot_id: "_unrouted", folder: "forwarded" });
  });

  it("rejects unknown recipients when that policy is set, and can fall through to a default bot", async () => {
    try {
    const reject = await worker.fetch(
      await adminRequest("/admin/api/routes/unknown", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ unknown_policy: "reject" }),
      }),
      env,
    );
    expect(reject.status).toBe(200);
    const raw = rawMime({
      from: "ada@example.com",
      to: "missing@bots.example.test",
      subject: "Nope",
      text: "reject me",
      messageId: "<reject-missing@bots.example.test>",
    });
    const incoming = inboundMessage(raw, "ada@example.com", "missing@bots.example.test");
    await processInboundEmail(incoming.message, env);
    expect(incoming.rejected()).toBe("Unknown recipient");
    const stored = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`)
      .bind("<reject-missing@bots.example.test>")
      .first();
    expect(stored).toBeNull();

    const fallback = await worker.fetch(
      await adminRequest("/admin/api/routes/unknown", {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ unknown_policy: "default_bot", unknown_bot: "post" }),
      }),
      env,
    );
    expect(fallback.status).toBe(200);
    await deliver(
      rawMime({
        from: "ada@example.com",
        to: "anyone@bots.example.test",
        subject: "Default box",
        text: "land in post",
        messageId: "<default-anyone@bots.example.test>",
      }),
      "ada@example.com",
      "anyone@bots.example.test",
    );
    const row = await env.DB.prepare(`SELECT bot_id FROM messages WHERE message_id_header = ?`)
      .bind("<default-anyone@bots.example.test>")
      .first<{ bot_id: string }>();
    expect(row?.bot_id).toBe("post");

    } finally {
      await worker.fetch(
        await adminRequest("/admin/api/routes/unknown", {
          method: "PUT",
          headers: adminHeaders,
          body: JSON.stringify({ unknown_policy: "unrouted", unknown_bot: "" }),
        }),
        env,
      );
    }
  });

  it("lets a disabled bot fall through to _unrouted", async () => {
    await updateBot(env, "eggbot", { enabled: false });
    try {
      await deliver(
        rawMime({
          from: "ada@example.com",
          to: "eggbot@bots.example.test",
          subject: "Disabled box",
          text: "not here",
          messageId: "<disabled-eggbot@bots.example.test>",
        }),
        "ada@example.com",
        "eggbot@bots.example.test",
      );
      const row = await env.DB.prepare(`SELECT bot_id, folder FROM messages WHERE message_id_header = ?`)
        .bind("<disabled-eggbot@bots.example.test>")
        .first<{ bot_id: string; folder: string }>();
      expect(row).toEqual({ bot_id: "_unrouted", folder: "_unrouted" });
    } finally {
      await updateBot(env, "eggbot", { enabled: true });
    }
  });
});
