import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { ADMIN_ORIGIN, adminRequest } from "./helpers";

async function get(path: string): Promise<Response> {
  return worker.fetch(await adminRequest(path), env);
}

describe("dashboard routes on the admin host", () => {
  it("serves the SPA shell for every clean URL", async () => {
    for (const path of ["/mail", "/mail/msg_123", "/bots", "/bots/forge", "/routing", "/domains", "/health", "/settings"]) {
      const response = await get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('<div id="app">');
      expect(html).toMatch(/<script type="module"[^>]+src="\/assets\//);
    }
  });

  it("redirects the root and the old /admin and /connect links", async () => {
    const root = await get("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(`${ADMIN_ORIGIN}/mail`);
    for (const [from, to] of [
      ["/admin", "/mail"],
      ["/admin/", "/mail"],
      ["/connect", "/bots"],
    ]) {
      const response = await get(from!);
      expect(response.status, from).toBe(301);
      expect(response.headers.get("location")).toBe(`${ADMIN_ORIGIN}${to}`);
    }
  });

  it("returns the shell with 404 for unknown paths and refuses writes to pages", async () => {
    const unknown = await get("/mail/a/b");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('<div id="app">');
    expect((await worker.fetch(await adminRequest("/settings", { method: "POST" }), env)).status).toBe(405);
  });

  it("serves hashed static assets and the favicon", async () => {
    const shell = await (await get("/mail")).text();
    const css = shell.match(/<link[^>]+href="(\/assets\/[^"]+\.css)"/)?.[1];
    expect(css).toBeTruthy();
    const style = await get(css!);
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
    const cssText = await style.text();
    expect(cssText).toContain("Geist Mono");
    expect(cssText).not.toContain("url(data:");
    const font = cssText.match(/url\((\/assets\/[^)]+\.woff2)\)/)?.[1];
    expect(font).toBeTruthy();
    expect((await get(font!)).status).toBe(200);
    expect((await get("/favicon.svg")).status).toBe(200);
  });

  it("keeps the dashboard and its API off the public host", async () => {
    const jwt = (await adminRequest("/mail")).headers.get("cf-access-jwt-assertion") ?? "";
    for (const path of ["/mail", "/bots", "/admin/api/bots", "/admin/api/session"]) {
      const response = await worker.fetch(new Request(`https://${env.PUBLIC_HOST}${path}`, { headers: { "cf-access-jwt-assertion": jwt } }), env);
      expect(response.status, path).toBe(404);
    }
    const health = await worker.fetch(new Request(`https://${env.PUBLIC_HOST}/health`), env);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    const root = await worker.fetch(new Request(`https://${env.PUBLIC_HOST}/`), env);
    expect(await root.text()).toBe("BotMail");
  });
});
