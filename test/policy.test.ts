import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rotateBotKey, saveAllowlist } from "../src/db";
import { buildSendPayload } from "../src/outbound";
import { decideSend, normalizeSendPolicy } from "../src/policy";
import worker from "../src/index";
import { adminRequest, deliver, mcpCall, rawMime } from "./helpers";

describe("external send approval", () => {
  it("classifies internal, allowlisted, and external recipients", () => {
    expect(decideSend({
      recipients: ["vespa@bots.example.test"],
      mailDomain: "bots.example.test",
      allowlist: [],
      policy: "approval",
    }).allowed).toBe(true);
    expect(decideSend({
      recipients: ["person@gmail.com"],
      mailDomain: "bots.example.test",
      allowlist: [],
      policy: "approval",
    })).toMatchObject({ allowed: false, external: ["person@gmail.com"] });
    expect(decideSend({
      recipients: ["ops@partner.example"],
      mailDomain: "bots.example.test",
      allowlist: ["partner.example"],
      policy: "approval",
    }).allowed).toBe(true);
    expect(decideSend({
      recipients: ["vespa@bots.example.test", "person@gmail.com"],
      mailDomain: "bots.example.test",
      allowlist: [],
      policy: "approval",
    }).allowed).toBe(false);
    expect(decideSend({
      recipients: ["person@gmail.com"],
      mailDomain: "bots.example.test",
      allowlist: [],
      policy: "direct",
    }).allowed).toBe(true);
    expect(normalizeSendPolicy("strict")).toBe("approval");
    expect(normalizeSendPolicy("open")).toBe("direct");
  });

  it("rejects outside recipients when the config allowlist is the only way out", () => {
    expect(decideSend({
      recipients: ["person@gmail.com"],
      mailDomain: "bots.example.test",
      allowlist: ["ops.example"],
      policy: "direct",
      allowlistOnly: true,
    })).toMatchObject({ allowed: false, external: ["person@gmail.com"] });
    expect(decideSend({
      recipients: ["vespa@bots.example.test", "ada@ops.example"],
      mailDomain: "bots.example.test",
      allowlist: ["ops.example"],
      policy: "direct",
      allowlistOnly: true,
    }).allowed).toBe(true);
  });

  it("puts threading headers on a reply payload", () => {
    const payload = buildSendPayload({
      fromEmail: "forge@bots.example.test",
      fromName: "Forge",
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Hull",
      text: "ack",
      inReplyTo: "orig@bots.example.test",
      references: "<root@bots.example.test> <orig@bots.example.test>",
    });
    expect(payload.headers?.["In-Reply-To"]).toBe("<orig@bots.example.test>");
    expect(payload.headers?.References).toContain("<orig@bots.example.test>");
  });

  it("sends bot-to-bot mail and holds external mail for approval", async () => {
    const forgeKey = await rotateBotKey(env, "aegis");
    const internal = (await mcpCall(forgeKey, "send_email", {
      to: ["quill@bots.example.test"],
      subject: "Inside the yard",
      text: "bot to bot",
    })) as { status: string; message_id: string };
    expect(internal.status).toBe("sent");
    const sent = await env.DB.prepare(`SELECT direction, folder, status, r2_key FROM messages WHERE id = ?`)
      .bind(internal.message_id)
      .first<{ direction: string; folder: string; status: string; r2_key: string }>();
    expect(sent).toMatchObject({ direction: "out", folder: "sent", status: "sent" });
    expect(sent?.r2_key.startsWith("aegis/")).toBe(true);

    const external = (await mcpCall(forgeKey, "send_email", {
      to: ["person@gmail.com", "quill@bots.example.test"],
      subject: "Outside",
      text: "please hold",
    })) as { status: string; message_id: string; external: string[] };
    expect(external.status).toBe("pending_approval");
    expect(external.external).toContain("person@gmail.com");
    const held = await env.DB.prepare(`SELECT status, folder, direction FROM messages WHERE id = ?`)
      .bind(external.message_id)
      .first<{ status: string; folder: string; direction: string }>();
    expect(held).toEqual({ status: "pending_approval", folder: "drafts", direction: "out" });

    const blocked = await worker.fetch(
      await adminRequest(`/admin/api/drafts/${external.message_id}/approve`, { method: "POST" }, { jwt: null }),
      env,
    );
    expect(blocked.status).toBe(401);

    const approved = await worker.fetch(
      await adminRequest(`/admin/api/drafts/${external.message_id}/approve`, {
        method: "POST",
        headers: {
          "x-bot-mail-action": "1",
          "content-type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as { status: string };
    expect(approvedBody.status).toBe("sent");
    const after = await env.DB.prepare(`SELECT status, folder FROM messages WHERE id = ?`)
      .bind(external.message_id)
      .first<{ status: string; folder: string }>();
    expect(after).toEqual({ status: "sent", folder: "sent" });
  });

  it("sends to an allowlisted domain and still holds everyone else", async () => {
    const eggKey = await rotateBotKey(env, "eggbot");
    await saveAllowlist(env, ["partner.example"]);
    const allowed = (await mcpCall(eggKey, "send_email", {
      to: ["ops@partner.example"],
      subject: "Partner",
      text: "allowed",
    })) as { status: string };
    expect(allowed.status).toBe("sent");
    const held = (await mcpCall(eggKey, "send_email", {
      to: ["ops@elsewhere.example"],
      subject: "Nope",
      text: "held",
    })) as { status: string };
    expect(held.status).toBe("pending_approval");
  });

  it("threads a reply to mail inside the domain", async () => {
    const quillKey = await rotateBotKey(env, "quill");
    await deliver(
      rawMime({
        from: "aegis@bots.example.test",
        to: "quill@bots.example.test",
        subject: "Specs",
        text: "original",
        messageId: "<specs-root@bots.example.test>",
      }),
      "aegis@bots.example.test",
      "quill@bots.example.test",
    );
    const original = await env.DB.prepare(`SELECT id FROM messages WHERE message_id_header = ?`)
      .bind("<specs-root@bots.example.test>")
      .first<{ id: string }>();
    const reply = (await mcpCall(quillKey, "reply", {
      message_id: original?.id ?? "",
      text: "received",
    })) as { status: string; message_id: string; thread_id: string };
    expect(reply.status).toBe("sent");
    const row = await env.DB.prepare(`SELECT in_reply_to, thread_id, r2_key, subject FROM messages WHERE id = ?`)
      .bind(reply.message_id)
      .first<{ in_reply_to: string; thread_id: string; r2_key: string; subject: string }>();
    expect(row?.in_reply_to).toBe("<specs-root@bots.example.test>");
    expect(row?.subject.startsWith("Re:")).toBe(true);
    expect(row?.thread_id).toBe("<specs-root@bots.example.test>");
    const archived = await env.MAIL_BUCKET.get(row?.r2_key ?? "");
    const eml = await archived?.text();
    expect(eml).toContain("In-Reply-To: <specs-root@bots.example.test>");
    expect(eml).toContain("References: <specs-root@bots.example.test>");
  });

  it("rejects a pending draft", async () => {
    const glyphKey = await rotateBotKey(env, "glyph");
    const held = (await mcpCall(glyphKey, "send_email", {
      to: ["person@gmail.com"],
      subject: "Do not send",
      text: "nope",
    })) as { message_id: string };
    const response = await worker.fetch(
      await adminRequest(`/admin/api/drafts/${held.message_id}/reject`, {
        method: "POST",
        headers: {
          "x-bot-mail-action": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "not now" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status, approval_reason FROM messages WHERE id = ?`)
      .bind(held.message_id)
      .first<{ status: string; approval_reason: string }>();
    expect(row).toEqual({ status: "rejected", approval_reason: "not now" });
  });

  it("sends external mail immediately in direct mode and keeps bot admin routes", async () => {
    const mutable = env as Env & { SEND_POLICY: string };
    const previous = mutable.SEND_POLICY;
    mutable.SEND_POLICY = "direct";
    try {
      const vistaKey = await rotateBotKey(env, "vista");
      const sent = (await mcpCall(vistaKey, "send_email", {
        to: ["person@gmail.com"],
        subject: "Straight out",
        text: "no hold",
      })) as { status: string; message_id: string };
      expect(sent.status).toBe("sent");
      const row = await env.DB.prepare(`SELECT status, folder FROM messages WHERE id = ?`)
        .bind(sent.message_id)
        .first<{ status: string; folder: string }>();
      expect(row).toEqual({ status: "sent", folder: "sent" });

      const session = await worker.fetch(await adminRequest("/admin/api/session"), env);
      expect(session.status).toBe(200);
      expect(((await session.json()) as { send_policy: string }).send_policy).toBe("direct");

      const created = await worker.fetch(
        await adminRequest("/admin/api/bots", {
          method: "POST",
          headers: {
            "x-bot-mail-action": "1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: "herald", display_name: "Herald" }),
        }),
        env,
      );
      expect(created.status).toBe(201);
      const rotated = await worker.fetch(
        await adminRequest("/admin/api/bots/herald/key", {
          method: "POST",
          headers: {
            "x-bot-mail-action": "1",
          },
        }),
        env,
      );
      expect(rotated.status).toBe(200);
      const body = (await rotated.json()) as { api_key: string };
      expect(body.api_key.startsWith("bm_herald_")).toBe(true);
    } finally {
      mutable.SEND_POLICY = previous;
    }
  });

  it("serves the dashboard shell without embedding mailbox data", async () => {
    const response = await worker.fetch(await adminRequest("/mail"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain('<div id="app">');
    expect(html).not.toContain("Do not send");
    expect(html).not.toContain("person@gmail.com");
  });
});
