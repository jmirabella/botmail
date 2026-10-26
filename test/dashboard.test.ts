import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { setDeliveryFetch } from "../src/webhook";
import { adminRequest, deliver, rawMime } from "./helpers";

const headers = {
  "content-type": "application/json",
  "x-bot-mail-action": "1",
};

describe("admin dashboard API", () => {
  it("ships connect copy in the bundle and keeps mailbox secrets write-only", async () => {
    const shell = await (await worker.fetch(await adminRequest("/bots/courier"), env)).text();
    const script = shell.match(/<script[^>]+src="([^"]+)"/)?.[1] ?? "";
    expect(script).toMatch(/^\/assets\/.+\.js$/);
    const bundle = await worker.fetch(await adminRequest(script), env);
    expect(bundle.status).toBe(200);
    const js = await bundle.text();
    expect(js).toContain("Streamable HTTP");
    expect(js).toContain("Send test wake");
    expect(js).toContain("no headers");
    expect(js).toContain("Connected clients");
    expect(js).not.toContain("ADMIN_API_KEY");
    expect(js).not.toContain("test-admin-key");

    const created = await worker.fetch(
      await adminRequest("/admin/api/bots", {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "courier", display_name: "Courier" }),
      }),
      env,
    );
    expect(created.status).toBe(201);
    const minted = (await created.json()) as { api_key: string; authorization: string };
    expect(minted.api_key.startsWith("bm_courier_")).toBe(true);
    expect(minted.authorization).toBe(`Bearer ${minted.api_key}`);

    const renamed = await worker.fetch(
      await adminRequest("/admin/api/bots/courier", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ display_name: "Courier desk", enabled: false }),
      }),
      env,
    );
    expect(renamed.status).toBe(200);
    const viewed = await worker.fetch(await adminRequest("/admin/api/bots/courier", { headers }), env);
    const body = (await viewed.json()) as { bot: Record<string, unknown> };
    expect(body.bot.display_name).toBe("Courier desk");
    expect(body.bot.enabled).toBe(false);
    expect(body.bot.key_configured).toBe(false);
    expect(body.bot.webhook_url).toBeNull();
    expect(JSON.stringify(body)).not.toContain(minted.api_key);
    expect(body.bot).not.toHaveProperty("api_key");
    expect(body.bot).not.toHaveProperty("webhook_key");

    const turnedOn = await worker.fetch(
      await adminRequest("/admin/api/bots/courier", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ enabled: true }),
      }),
      env,
    );
    expect(turnedOn.status).toBe(200);
    const enabledAgain = (await turnedOn.json()) as { bot: { enabled: boolean; key_configured: boolean; webhook_configured: boolean } };
    expect(enabledAgain.bot.enabled).toBe(true);
    expect(enabledAgain.bot.key_configured).toBe(false);
    expect(enabledAgain.bot.webhook_configured).toBe(false);

    const hooked = await worker.fetch(
      await adminRequest("/admin/api/bots/courier/webhook", {
        method: "PUT",
        headers,
        body: JSON.stringify({ url: "https://hooks.example.test/courier", key: "courier-sender" }),
      }),
      env,
    );
    expect(hooked.status).toBe(200);
    const afterHook = (await (
      await worker.fetch(await adminRequest("/admin/api/bots/courier", { headers }), env)
    ).json()) as { bot: { webhook_url: string; webhook_configured: boolean } };
    expect(afterHook.bot.webhook_url).toBe("https://hooks.example.test/courier");
    expect(afterHook.bot.webhook_configured).toBe(true);
    expect(JSON.stringify(afterHook)).not.toContain("courier-sender");

    const seen: string[] = [];
    setDeliveryFetch(async (_input, init) => {
      seen.push(String(init?.body ?? ""));
      return new Response(null, { status: 204 });
    });
    try {
      const wake = await worker.fetch(
        await adminRequest("/admin/api/bots/courier/test-wake", { method: "POST", headers }),
        env,
      );
      expect(wake.status).toBe(200);
      const wakeBody = (await wake.json()) as { status: string };
      expect(wakeBody.status).toBe("success");
      expect(seen[0]).toContain("wake_test");
      expect(seen[0]).not.toContain("courier-sender");
    } finally {
      setDeliveryFetch(null);
    }

    const removed = await worker.fetch(await adminRequest("/admin/api/bots/courier", { method: "DELETE", headers }), env);
    expect(removed.status).toBe(200);
    const gone = await worker.fetch(await adminRequest("/admin/api/bots/courier", { headers }), env);
    expect(gone.status).toBe(200);
    const archived = (await gone.json()) as { bot: { archived: boolean; id: string } };
    expect(archived.bot.id).toBe("courier");
    expect(archived.bot.archived).toBe(true);
  });

  it("lists mail, sanitizes html, downloads raw eml, saves settings, and retries a delivery", async () => {
    await deliver(
      rawMime({
        from: "Ada <ada@example.com>",
        to: "glyph@bots.example.test",
        subject: "Dashboard detail",
        text: "hello timeline",
        messageId: "<dash-glyph@bots.example.test>",
      }),
      "ada@example.com",
      "glyph@bots.example.test",
    );
    const list = await worker.fetch(
      await adminRequest("/admin/api/mail?q=Dashboard%20detail&direction=in&bot=glyph", {}),
      env,
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { messages: Array<{ id: string; subject: string | null }> };
    const message = listed.messages.find((row) => row.subject === "Dashboard detail");
    expect(message?.id).toBeTruthy();

    await env.DB.prepare(`UPDATE messages SET html_body = ? WHERE id = ?`)
      .bind("<p>Visible</p><script>alert(1)</script>", message?.id)
      .run();
    const detail = await worker.fetch(await adminRequest(`/admin/api/mail/${message?.id}`, { headers }), env);
    const detailBody = (await detail.json()) as { message: { html: string; text: string; headers: { subject: string } } };
    expect(detailBody.message.text).toContain("hello timeline");
    expect(detailBody.message.html).toContain("Visible");
    expect(detailBody.message.html).not.toContain("<script>");
    expect(detailBody.message.headers.subject).toBe("Dashboard detail");

    const raw = await worker.fetch(await adminRequest(`/admin/api/mail/${message?.id}/raw`, { headers }), env);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("message/rfc822");
    expect(raw.headers.get("content-disposition")).toContain(".eml");
    expect(await raw.text()).toContain("Dashboard detail");

    const saved = await worker.fetch(
      await adminRequest("/admin/api/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          brand_name: "BotMail",
          brand_accent: "#3366ff",
          allowlist: ["ops.example.com"],
          send_policy: "approval",
          send_policy_source: "config",
        }),
      }),
      env,
    );
    expect(saved.status).toBe(200);
    const settings = (await saved.json()) as { brand_accent: string; allowlist: string[]; send_policy_source: string };
    expect(settings.brand_accent).toBe("#3366ff");
    expect(settings.allowlist).toContain("ops.example.com");
    expect(settings.send_policy_source).toBe("config");

    const health = await worker.fetch(await adminRequest("/admin/api/health", { headers }), env);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { deliveries: Array<{ id: string }>; counts: unknown[]; dns: { domain: string; checks: Array<{ id: string; state: string }> } };
    expect(Array.isArray(healthBody.deliveries)).toBe(true);
    expect(Array.isArray(healthBody.counts)).toBe(true);
    expect(healthBody.dns.domain).toBe(env.MAIL_DOMAIN);
    expect(healthBody.dns.checks.map((item) => item.id)).toEqual(["dns_mx", "dns_return", "dns_spf", "dns_dkim", "dns_dmarc"]);

    const delivery = healthBody.deliveries[0];
    if (delivery) {
      setDeliveryFetch(async () => new Response(null, { status: 204 }));
      try {
        const retried = await worker.fetch(
          await adminRequest(`/admin/api/webhooks/${delivery.id}/retry`, { method: "POST", headers }),
          env,
        );
        expect(retried.status).toBe(200);
      } finally {
        setDeliveryFetch(null);
      }
    }
  });

  it("reports bot stats, marks mail read, and downloads attachments behind Access", async () => {
    await deliver(
      rawMime({
        from: "Grace <grace@example.com>",
        to: "athena@bots.example.test",
        subject: "Quarterly notes",
        text: "see attached",
        messageId: "<stats-athena@bots.example.test>",
        attachment: { filename: "notes.txt", content: "line one", type: "text/plain" },
      }),
      "grace@example.com",
      "athena@bots.example.test",
    );
    const listed = (await (await worker.fetch(await adminRequest("/admin/api/bots"), env)).json()) as {
      bots: Array<{ id: string; unread_count: number; message_count: number; last_mail_at: string | null; webhook_status: string }>;
    };
    const athena = listed.bots.find((bot) => bot.id === "athena");
    expect(athena?.message_count).toBeGreaterThan(0);
    expect(athena?.unread_count).toBeGreaterThan(0);
    expect(athena?.last_mail_at).toBeTruthy();
    expect(athena?.webhook_status).toBe("none");

    const mail = (await (await worker.fetch(await adminRequest("/admin/api/mail?bot=athena"), env)).json()) as { messages: Array<{ id: string; subject: string }> };
    const message = mail.messages.find((row) => row.subject === "Quarterly notes");
    expect(message).toBeTruthy();
    const read = await worker.fetch(
      await adminRequest(`/admin/api/mail/${message!.id}`, { method: "PATCH", headers, body: JSON.stringify({ is_read: true }) }),
      env,
    );
    expect(read.status).toBe(200);
    const after = (await (await worker.fetch(await adminRequest("/admin/api/bots/athena"), env)).json()) as { bot: { unread_count: number } };
    expect(after.bot.unread_count).toBe(athena!.unread_count - 1);
    const badRead = await worker.fetch(await adminRequest(`/admin/api/mail/${message!.id}`, { method: "PATCH", headers, body: "{}" }), env);
    expect(badRead.status).toBe(400);

    const detail = (await (await worker.fetch(await adminRequest(`/admin/api/mail/${message!.id}`), env)).json()) as {
      message: { attachments: Array<{ id: string; filename: string }> };
    };
    const attachment = detail.message.attachments[0];
    expect(attachment?.filename).toBe("notes.txt");
    const download = await worker.fetch(await adminRequest(`/admin/api/mail/${message!.id}/attachments/${attachment!.id}`), env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("notes.txt");
    expect(await download.text()).toBe("line one");
    const anonymous = await worker.fetch(await adminRequest(`/admin/api/mail/${message!.id}/attachments/${attachment!.id}`, {}, { jwt: null }), env);
    expect(anonymous.status).toBe(401);
  });
});
