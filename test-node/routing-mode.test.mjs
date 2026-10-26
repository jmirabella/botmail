import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGroupConfig, pathsForConfig, validateGroupConfig } from "../scripts/group-config.mjs";
import { runSetup } from "../scripts/setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

function baseGroup(extra = {}) {
  return validateGroupConfig({ ...loadGroupConfig(path.join(root, "test/group.config.json")), ...extra });
}

function harness(group, request, { forceCatchAll = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-route-"));
  const calls = [];
  const lines = [];
  const run = () =>
    runSetup({
      config: group,
      token: "token",
      accountId: "account",
      env: {},
      lines,
      forceCatchAll,
      secretsPath: path.join(directory, "saved.secrets"),
      statePath: path.join(directory, "state.json"),
      wranglerPath: path.join(directory, "wrangler.jsonc"),
      tempDir: directory,
      io: { write() {} },
      nodeVersion: "22.14.0",
      buildDashboard: () => ({ code: 0, stdout: "", stderr: "" }),
      wrangler(args) {
        if (args[0] === "d1" && args[1] === "info") {
          return { code: 0, stdout: '{"uuid":"11111111-1111-1111-1111-111111111111"}', stderr: "" };
        }
        if (args[0] === "kv" && args[1] === "namespace" && args[2] === "create") {
          return { code: 0, stdout: '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      request(method, requestPath, body) {
        calls.push({ method, requestPath, body });
        return request(method, requestPath, body, calls);
      },
    });
  return {
    calls,
    lines,
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    wrangler: () => readFileSync(path.join(directory, "wrangler.jsonc"), "utf8"),
  };
}

function cloudflare(group, extras = {}) {
  return (method, requestPath, body) => {
    if (requestPath.startsWith("/zones?")) return [{ id: "zone1", name: group.mailZone, status: "active" }];
    if (requestPath.endsWith("/email/routing") && !requestPath.includes("/rules")) return { enabled: true, support_subaddress: true };
    if (requestPath.endsWith("/email/sending/subdomains")) return [{ name: group.mailDomain, enabled: true }];
    if (requestPath.endsWith("/secrets")) return [{ name: "ADMIN_API_KEY" }, { name: "DATA_KEY" }, { name: "MAIL_DOMAIN" }];
    if (requestPath.endsWith("/query")) {
      const sql = String(body?.sql || "");
      if (sql.includes("FROM bots")) return [{ results: extras.bots || [] }];
      return [{ results: [] }];
    }
    if (requestPath.includes("/email/routing/rules") && !requestPath.includes("catch_all")) {
      if (method === "GET") return extras.rules || [];
      if (method === "POST") return { id: "rule1", ...(body || {}) };
      return { id: "rule1" };
    }
    if (requestPath.includes("/rules/catch_all") && method === "GET") return extras.catchAll;
    if (requestPath.includes("/rules/catch_all") && method === "PUT") return { enabled: true };
    if (requestPath.endsWith("/workers/subdomain")) return { subdomain: "example" };
    return [];
  };
}

describe("literal routing", () => {
  it("creates one literal rule per mailbox and never touches the catch-all", async () => {
    const staging = loadGroupConfig(path.join(root, "bot-mail.staging.json"));
    expect(staging.routing).toBe("literal");
    expect(staging.outboundAllowlistOnly).toBe(true);
    expect(staging.mailDomain.endsWith(`.${staging.mailZone}`)).toBe(true);
    expect(staging.workerName).not.toBe("bot-mail");
    expect(pathsForConfig("bot-mail.config.json").statePath).toBe("bot-mail.state.json");
    expect(pathsForConfig("bot-mail.staging.json")).toEqual({
      statePath: "bot-mail.staging.state.json",
      secretsPath: ".bot-mail.staging.secrets",
    });
    const group = baseGroup({ routing: "literal" });
    const address = `herald@${group.mailDomain}`;
    const rule = {
      id: "rule1",
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [group.workerName] }],
    };
    const first = harness(group, cloudflare(group, { bots: [{ id: "herald", address_local: "herald", domain: group.mailDomain }] }));
    try {
      await first.run();
      expect(first.calls.some((call) => call.requestPath.includes("catch_all"))).toBe(false);
      expect(first.calls.some((call) => call.method === "DELETE")).toBe(false);
      const created = first.calls.find((call) => call.method === "POST" && call.requestPath.includes("/email/routing/rules"));
      expect(created?.body).toMatchObject({
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: address }],
        actions: [{ type: "worker", value: [group.workerName] }],
      });
      expect(first.lines.join("\n")).toContain(`literal rule created for ${address}`);
      expect(first.wrangler()).toContain('"ROUTING_MODE": "literal"');
      expect(first.wrangler()).not.toContain('"addresses"');
    } finally {
      first.cleanup();
    }

    const again = harness(group, cloudflare(group, { bots: [{ id: "herald", address_local: "herald", domain: group.mailDomain }], rules: [rule] }));
    try {
      await again.run();
      expect(again.calls.some((call) => call.requestPath.includes("catch_all"))).toBe(false);
      expect(again.calls.some((call) => call.method === "POST" && call.requestPath.includes("/email/routing/rules"))).toBe(false);
      expect(again.calls.some((call) => call.method === "PUT")).toBe(false);
      expect(again.lines.join("\n")).toContain(`literal rule for ${address} already sends to this worker`);
    } finally {
      again.cleanup();
    }
  });
});

describe("catch-all guard", () => {
  it("refuses a catch-all that already points at another worker", async () => {
    const group = baseGroup();
    const setup = harness(
      group,
      cloudflare(group, { catchAll: { enabled: true, actions: [{ type: "worker", value: ["other-worker"] }] } }),
    );
    try {
      await expect(setup.run()).rejects.toThrow(/other-worker/);
      expect(setup.calls.some((call) => call.method === "PUT" && call.requestPath.includes("catch_all"))).toBe(false);
      expect(setup.calls.some((call) => call.method === "DELETE")).toBe(false);
      expect(setup.wrangler()).not.toContain("ROUTING_MODE");
    } finally {
      setup.cleanup();
    }
  });

  it("leaves this worker's catch-all in place and replaces a foreign one only with --force-catch-all", async () => {
    const group = baseGroup();
    const same = harness(group, cloudflare(group, { catchAll: { enabled: true, actions: [{ type: "worker", value: [group.workerName] }] } }));
    try {
      await same.run();
      expect(same.lines.join("\n")).toContain("catch-all already sends to this worker");
      expect(same.calls.some((call) => call.method === "PUT" && call.requestPath.includes("catch_all"))).toBe(false);
    } finally {
      same.cleanup();
    }

    const forced = harness(
      group,
      cloudflare(group, { catchAll: { enabled: false, actions: [{ type: "worker", value: ["other-worker"] }] } }),
      { forceCatchAll: true },
    );
    try {
      await forced.run();
      const put = forced.calls.find((call) => call.method === "PUT" && call.requestPath.includes("catch_all"));
      expect(put?.body?.actions).toEqual([{ type: "worker", value: [group.workerName] }]);
      expect(forced.lines.join("\n")).toContain("catch-all updated to this worker");
      expect(forced.calls.some((call) => call.method === "DELETE")).toBe(false);
    } finally {
      forced.cleanup();
    }
  });
});
