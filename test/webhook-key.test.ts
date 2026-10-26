import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { getBot, setBotWebhook, webhookKey } from "../src/db";
import worker from "../src/index";
import { adminRequest } from "./helpers";

const headers = { "content-type": "application/json", "x-bot-mail-action": "1" };

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(await adminRequest(path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } }), env);
}

afterEach(async () => {
  await env.DB.prepare(`DELETE FROM bots WHERE id = 'plainkey'`).run();
});

describe("Routine Webhook key", () => {
  it("strips a leading Bearer and rejects an empty key without saving the URL", async () => {
    const created = await api("/admin/api/bots", {
      method: "POST",
      body: JSON.stringify({ local_part: "plainkey", display_name: "Plain key" }),
    });
    expect(created.status).toBe(201);

    await setBotWebhook(env, "plainkey", "https://hooks.example.test/plainkey", "  BeArEr   routine-secret  ");
    const stored = await getBot(env, "plainkey");
    expect(stored?.webhook_url).toBe("https://hooks.example.test/plainkey");
    expect(await webhookKey(env, stored!)).toBe("routine-secret");

    await expect(setBotWebhook(env, "plainkey", "https://hooks.example.test/nope", "Bearer")).rejects.toThrow("Routine Webhook key required");
    expect((await getBot(env, "plainkey"))?.webhook_url).toBe("https://hooks.example.test/plainkey");

    const rejected = await api("/admin/api/bots/plainkey/webhook", {
      method: "PUT",
      body: JSON.stringify({ url: "https://hooks.example.test/admin", key: "Bearer " }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toBe("Routine Webhook key required");
    expect((await getBot(env, "plainkey"))?.webhook_url).toBe("https://hooks.example.test/plainkey");

    const saved = await api("/admin/api/bots/plainkey/webhook", {
      method: "PUT",
      body: JSON.stringify({ url: "https://hooks.example.test/admin", key: "bearer admin-secret" }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain("admin-secret");
    const next = await getBot(env, "plainkey");
    expect(next?.webhook_url).toBe("https://hooks.example.test/admin");
    expect(await webhookKey(env, next!)).toBe("admin-secret");
  });
});
