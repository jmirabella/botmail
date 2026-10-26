import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGroupConfig, validateGroupConfig } from "../scripts/group-config.mjs";
import { renderWrangler, workersDevEnabled } from "../scripts/render-wrangler.mjs";
import {
  accessApplicationBody,
  accessDeniedWarning,
  assertSupportedNode,
  defaultDomainStatements,
  describePlan,
  ensureAccessApplication,
  manualFallbacks,
  runSetup,
  secretsForDeploy,
} from "../scripts/setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

// Same newline-separated list the public sync reads. Unset or blank skips the guard.
function forbiddenStrings() {
  return (process.env.PUBLIC_SYNC_DENYLIST ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertNoForbidden(text) {
  const haystack = text.toLowerCase();
  for (const needle of forbiddenStrings()) {
    expect(haystack).not.toContain(needle.toLowerCase());
  }
}

describe("group config", () => {
  it("loads the example and the test group", () => {
    const example = loadGroupConfig(path.join(root, "bot-mail.config.example.jsonc"));
    const testGroup = loadGroupConfig(path.join(root, "test/group.config.json"));
    expect(example.sendPolicy).toBe("approval");
    expect(example.mailDomain).toBe("bot.example.email");
    expect(example.mailZone).toBe("example.email");
    expect(example.bots).toBeUndefined();
    expect(testGroup.mailDomain).toBe("bots.example.test");
    expect(testGroup.mailZone).toBe("example.test");
  });

  it("rejects a mail domain outside the zone", () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    expect(() => validateGroupConfig({ ...group, mailDomain: "bot.other.test" })).toThrow(/subdomain of mailZone/);
    expect(() => validateGroupConfig({ ...group, sendPolicy: "strict" })).toThrow(/direct" or "approval/);
  });
});

describe("generated wrangler config", () => {
  it("puts the zone catch-all and resource names in the file", () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    const text = renderWrangler(group, "11111111-1111-1111-1111-111111111111");
    expect(text).toContain('"name": "bot-mail"');
    expect(text).toContain('"database_name": "bot-mail-test"');
    expect(text).toContain('"bucket_name": "bot-mail-test"');
    expect(text).toContain('"BRAND_NAME": "BotMail"');
    expect(text).toContain('"SEND_POLICY": "approval"');
    const direct = renderWrangler({ ...group, sendPolicy: "direct" }, "11111111-1111-1111-1111-111111111111");
    expect(direct).toContain('"SEND_POLICY": "direct"');
    expect(text).not.toContain('"addresses"');
    expect(text).toContain('"preview_urls": false');
    expect(text).toContain('"directory": "./dashboard/dist"');
    expect(text).toContain('"run_worker_first": true');
    assertNoForbidden(text);
  });

  it("keeps workers.dev on when a custom domain is also configured", () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    const withDomain = validateGroupConfig({
      ...group,
      adminHost: "mail-admin.example.test",
      publicHost: "bot-mail.example.workers.dev",
      workersDev: false,
      access: { allowedEmailDomains: ["example.com"] },
    });
    const text = renderWrangler(withDomain, "11111111-1111-1111-1111-111111111111");
    expect(workersDevEnabled(withDomain)).toBe(true);
    expect(text).toContain('"workers_dev": true');
    expect(text).toContain('"custom_domain": true');
    expect(text).toContain('"PUBLIC_HOST": "bot-mail.example.workers.dev"');

    const defaults = renderWrangler(group, "11111111-1111-1111-1111-111111111111");
    expect(defaults).toContain('"workers_dev": true');

    const off = renderWrangler(
      validateGroupConfig({ ...group, publicHost: "mail.example.test", workersDev: false }),
      "11111111-1111-1111-1111-111111111111",
    );
    expect(off).toContain('"workers_dev": false');
    expect(workersDevEnabled({ publicHost: "bot-mail.example.workers.dev", workersDev: false })).toBe(true);
  });
});

describe("setup leaves mailboxes alone", () => {
  it("ignores a bots list and does not plan mailbox changes", () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    let parsed;
    try {
      parsed = validateGroupConfig({ ...group, bots: [{ id: "forge", displayName: "Forge" }] });
    } finally {
      console.warn = warn;
    }
    expect(parsed.bots).toBeUndefined();
    expect(warnings).toEqual([
      "bots in the config is deprecated and ignored. Add mailboxes on the dashboard. Setup does not create or change them.",
    ]);
    const plan = describePlan(parsed).join("\n");
    expect(plan).toContain("does not create, change, or remove bots");
    expect(plan).toContain("zero bots");
    expect(plan).toContain("Add them on the dashboard");
    expect(plan).not.toContain("Seed ");
    expect(plan).not.toContain("api_key_hash");
    const sql = defaultDomainStatements(parsed.mailDomain, "2026-01-01T00:00:00.000Z").map((statement) => statement.sql).join("\n");
    expect(sql).toContain("mail_domains");
    expect(sql).not.toMatch(/\bbots\b|\broutes\b|\bmessages\b/);
  });
});

describe("setup plan", () => {
  it("prints every step and makes no calls on dry-run", async () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    const lines = [];
    let wranglerCalls = 0;
    let apiCalls = 0;
    await runSetup({
      config: group,
      dryRun: true,
      lines,
      io: { write() {} },
      wrangler: () => {
        wranglerCalls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      request: () => {
        apiCalls += 1;
        return {};
      },
    });
    const text = lines.join("\n");
    expect(text).toContain("dry-run: no Cloudflare calls were made");
    expect(text).toContain("POST /zones/{zone_id}/email/routing/enable");
    expect(text).toContain("email/sending/subdomains");
    expect(text).toContain("*@example.test");
    expect(text).toContain("bots.example.test");
    expect(text).toContain("Subdomains");
    expect(describePlan(group).length).toBeGreaterThan(5);
    expect(manualFallbacks(group).join("\n")).toContain("Onboard Domain");
    expect(wranglerCalls).toBe(0);
    expect(apiCalls).toBe(0);
    assertNoForbidden(text);
  });
});

describe("access application", () => {
  it("requires an admin host inside the zone and builds an email-domain policy", () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    expect(() =>
      validateGroupConfig({
        ...group,
        adminHost: "admin.other.test",
        access: { allowedEmailDomains: ["example.com"] },
      }),
    ).toThrow(/mailZone/);
    const configured = validateGroupConfig({
      ...group,
      adminHost: "mail-admin.example.test",
      publicHost: "bots.example.test",
      access: { teamDomain: "exampleteam", allowedEmailDomains: ["example.com"] },
    });
    const plan = describePlan(configured).join("\n");
    expect(plan).toContain("/access/apps");
    expect(plan).toContain("mail-admin.example.test");
    expect(plan).toContain("/workers/domains");
    expect(manualFallbacks(configured).join("\n")).toContain("Zero Trust");
    const body = accessApplicationBody(configured);
    expect(body.type).toBe("self_hosted");
    expect(body.domain).toBe("mail-admin.example.test");
    expect(body.policies[0].include).toEqual([{ email_domain: { domain: "example.com" } }]);
    const text = renderWrangler(configured, "11111111-1111-1111-1111-111111111111", { accessAud: "aud-from-state" });
    expect(text).toContain('"CF_ACCESS_AUD": "aud-from-state"');
    expect(text).toContain('"CF_ACCESS_TEAM_DOMAIN": "exampleteam"');
    expect(text).toContain('"pattern": "mail-admin.example.test"');
    expect(text).toContain('"custom_domain": true');
    expect(text).toContain("example.com");
    assertNoForbidden(text);
  });

  it("updates an existing Access application instead of creating a second one", async () => {
    const group = validateGroupConfig({
      ...loadGroupConfig(path.join(root, "test/group.config.json")),
      adminHost: "mail-admin.example.test",
      access: { allowedEmailDomains: ["example.com"] },
    });
    const calls = [];
    const result = await ensureAccessApplication(
      {
        accountId: "account",
        request(method, requestPath, body) {
          calls.push({ method, requestPath, body });
          if (method === "GET" && requestPath.endsWith("/access/apps")) {
            return [{ id: "app1", domain: "mail-admin.example.test", aud: "aud-existing" }];
          }
          if (method === "GET" && requestPath.endsWith("/policies")) return [];
          if (method === "PUT") return { id: "app1", aud: "aud-existing" };
          if (method === "POST" && requestPath.endsWith("/policies")) return { id: "policy1" };
          return {};
        },
      },
      group,
    );
    expect(result).toEqual({ id: "app1", aud: "aud-existing" });
    expect(calls.some((call) => call.method === "POST" && call.requestPath.endsWith("/access/apps"))).toBe(false);
    expect(calls.some((call) => call.method === "PUT" && call.requestPath.endsWith("/access/apps/app1"))).toBe(true);
    expect(calls.some((call) => call.method === "POST" && call.requestPath.endsWith("/policies"))).toBe(true);
  });

  it("warns that the dashboard is unprotected when Access returns 403", async () => {
    const group = validateGroupConfig({
      ...loadGroupConfig(path.join(root, "test/group.config.json")),
      adminHost: "mail-admin.example.test",
      publicHost: "bot-mail.example.workers.dev",
      access: { allowedEmailDomains: ["example.com"] },
    });
    expect(accessDeniedWarning(group, "GET /access/apps (403): Authentication error")).toEqual([
      "WARNING: Access was not created (403). The dashboard on mail-admin.example.test is unprotected.",
      "WARNING: The API token needs Access: Apps and Policies Edit and Access: Organizations Read.",
    ]);
    expect(accessDeniedWarning(group, "GET /access/apps (404): missing")).toEqual([]);

    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-access-"));
    const lines = [];
    try {
      await runSetup({
        config: group,
        token: "token",
        accountId: "account",
        env: {},
        lines,
        secretsPath: path.join(directory, "saved.secrets"),
        statePath: path.join(directory, "state.json"),
        wranglerPath: path.join(directory, "wrangler.jsonc"),
        tempDir: directory,
        io: { write() {} },
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
        request(method, requestPath) {
          if (requestPath.includes("/access/apps")) {
            throw new Error(`GET ${requestPath} (403): Authentication error`);
          }
          if (requestPath.startsWith("/zones?")) return [{ id: "zone1", name: group.mailZone, status: "active" }];
          if (requestPath.endsWith("/email/routing")) return { enabled: true, support_subaddress: true };
          if (requestPath.endsWith("/email/sending/subdomains")) return [{ name: group.mailDomain, enabled: true }];
          if (requestPath.endsWith("/secrets")) return [{ name: "ADMIN_API_KEY" }, { name: "DATA_KEY" }, { name: "MAIL_DOMAIN" }];
          if (requestPath.endsWith("/rules/catch_all")) return { enabled: true, actions: [{ type: "worker", value: [group.workerName] }] };
          if (requestPath.endsWith("/query")) return [{ results: [{ api_key_hash: "already" }] }];
          if (requestPath.endsWith("/workers/subdomain")) return { subdomain: "example" };
          if (requestPath.endsWith("/workers/domains") && method === "POST") return { hostname: group.adminHost };
          return [];
        },
      });
      const text = lines.join("\n");
      expect(text).toContain("WARNING: Access was not created (403). The dashboard on mail-admin.example.test is unprotected.");
      expect(text).toContain("Access: Apps and Policies Edit");
      expect(text).toContain("Access: Organizations Read");
      expect(readFileSync(path.join(directory, "wrangler.jsonc"), "utf8")).toContain('"workers_dev": true');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("node engine", () => {
  it("accepts Node 22 and rejects older Node", () => {
    expect(() => assertSupportedNode("22.14.0")).not.toThrow();
    expect(() => assertSupportedNode("20.11.1")).toThrow(/Node\.js 22 or newer/);
  });
});

describe("deploy secrets", () => {
  it("reuses a saved key and skips secrets the Worker already has", () => {
    const first = secretsForDeploy({
      existingNames: [],
      saved: {},
      mailDomain: "bots.example.test",
      random: () => "generated-once",
    });
    expect(first.upload).toEqual({
      ADMIN_API_KEY: "generated-once",
      DATA_KEY: "generated-once",
      MAIL_DOMAIN: "bots.example.test",
    });
    expect(first.issued.generatedAdmin).toBe(true);

    const again = secretsForDeploy({
      existingNames: [],
      saved: { ADMIN_API_KEY: "generated-once", DATA_KEY: "generated-once" },
      mailDomain: "bots.example.test",
      random: () => "generated-twice",
    });
    expect(again.upload.ADMIN_API_KEY).toBe("generated-once");
    expect(again.upload.DATA_KEY).toBe("generated-once");
    expect(again.issued.generatedAdmin).toBe(false);

    const present = secretsForDeploy({
      existingNames: ["ADMIN_API_KEY", "DATA_KEY", "MAIL_DOMAIN"],
      saved: { ADMIN_API_KEY: "generated-once" },
      mailDomain: "bots.example.test",
      random: () => "generated-twice",
    });
    expect(present.upload).toEqual({});
  });
});

describe("first deploy", () => {
  it("passes a mode 600 secrets file, deletes it, and owns the catch-all so a rerun deploys cleanly", async () => {
    const group = loadGroupConfig(path.join(root, "test/group.config.json"));
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-setup-"));
    const secretsPath = path.join(directory, "saved.secrets");
    const lines = [];
    const wranglerArgs = [];
    const apiCalls = [];
    let seenFile = "";
    try {
      const result = await runSetup({
        config: group,
        token: "token",
        accountId: "account",
        env: {},
        lines,
        secretsPath,
        statePath: path.join(directory, "state.json"),
        wranglerPath: path.join(directory, "wrangler.jsonc"),
        tempDir: directory,
        io: { write() {} },
        buildDashboard: () => ({ code: 0, stdout: "", stderr: "" }),
        wrangler(args) {
          wranglerArgs.push(args);
          const fileFlag = args.indexOf("--secrets-file");
          if (fileFlag >= 0) {
            seenFile = args[fileFlag + 1];
            expect(statSync(seenFile).mode & 0o777).toBe(0o600);
            const text = readFileSync(seenFile, "utf8");
            expect(text).toContain("ADMIN_API_KEY=");
            expect(text).toContain("MAIL_DOMAIN=bots.example.test");
            assertNoForbidden(text);
          }
          if (args[0] === "d1" && args[1] === "info") {
            return { code: 0, stdout: '{"uuid":"11111111-1111-1111-1111-111111111111"}', stderr: "" };
          }
          if (args[0] === "kv" && args[1] === "namespace" && args[2] === "create") {
            return { code: 0, stdout: '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        request(method, requestPath) {
          apiCalls.push(`${method} ${requestPath}`);
          if (requestPath.startsWith("/zones?")) return [{ id: "zone1", name: group.mailZone, status: "active" }];
          if (requestPath.endsWith("/email/routing")) return { enabled: true, support_subaddress: true };
          if (requestPath.endsWith("/email/sending/subdomains")) return [{ name: group.mailDomain, enabled: true }];
          if (requestPath.endsWith("/secrets")) {
            throw new Error("GET /secrets (404): This Worker does not exist [code: 10007]");
          }
          if (requestPath.endsWith("/rules/catch_all") && method === "GET") return { enabled: false, actions: [] };
          if (requestPath.endsWith("/rules/catch_all") && method === "PUT") return { enabled: true };
          if (requestPath.endsWith("/query")) return [{ results: [{ api_key_hash: "already" }] }];
          if (requestPath.endsWith("/workers/subdomain")) return { subdomain: "example" };
          return [];
        },
      });
      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(directory, "wrangler.jsonc"), "utf8")).not.toContain('"addresses"');
      expect(seenFile).not.toBe("");
      expect(() => statSync(seenFile)).toThrow();
      expect(wranglerArgs.some((args) => args[0] === "deploy" && args.includes("--secrets-file"))).toBe(true);
      expect(apiCalls.some((call) => call.startsWith("PUT ") && call.includes("/rules/catch_all"))).toBe(true);
      const text = lines.join("\n");
      expect(text).toContain("catch-all updated to this worker");
      expect(text).toContain("built dashboard");
      expect(text).toContain("ADMIN_API_KEY ");
      assertNoForbidden(text);

      const saved = readFileSync(secretsPath, "utf8");
      const admin = saved.match(/^ADMIN_API_KEY=(.+)$/m)?.[1];
      const secondArgs = [];
      const secondCalls = [];
      const secondLines = [];
      const rerun = await runSetup({
        config: group,
        token: "token",
        accountId: "account",
        env: {},
        lines: secondLines,
        secretsPath,
        statePath: path.join(directory, "state.json"),
        wranglerPath: path.join(directory, "wrangler.jsonc"),
        tempDir: directory,
        io: { write() {} },
        buildDashboard: () => ({ code: 0, stdout: "", stderr: "" }),
        wrangler(args) {
          secondArgs.push(args);
          if (args[0] === "d1" && args[1] === "info") {
            return { code: 0, stdout: '{"uuid":"11111111-1111-1111-1111-111111111111"}', stderr: "" };
          }
          if (args[0] === "kv" && args[1] === "namespace" && args[2] === "create") {
            return { code: 0, stdout: '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        request(method, requestPath) {
          secondCalls.push(`${method} ${requestPath}`);
          if (requestPath.startsWith("/zones?")) return [{ id: "zone1", name: group.mailZone, status: "active" }];
          if (requestPath.endsWith("/email/routing")) return { enabled: true, support_subaddress: true };
          if (requestPath.endsWith("/email/sending/subdomains")) return [{ name: group.mailDomain, enabled: true }];
          if (requestPath.endsWith("/secrets")) {
            return [{ name: "ADMIN_API_KEY" }, { name: "DATA_KEY" }, { name: "MAIL_DOMAIN" }];
          }
          if (requestPath.endsWith("/rules/catch_all")) return { enabled: true, actions: [{ type: "worker", value: [group.workerName] }] };
          if (requestPath.endsWith("/query")) return [{ results: [{ api_key_hash: "already" }] }];
          if (requestPath.endsWith("/workers/subdomain")) return { subdomain: "example" };
          return [];
        },
      });
      const redeploy = secondArgs.find((args) => args[0] === "deploy");
      expect(redeploy.includes("--secrets-file")).toBe(false);
      expect(rerun.ok).toBe(true);
      expect(secondLines.join("\n")).toContain("catch-all already sends to this worker");
      expect(secondCalls.some((call) => call.startsWith("PUT ") && call.includes("/rules/catch_all"))).toBe(false);
      expect(readFileSync(secretsPath, "utf8").match(/^ADMIN_API_KEY=(.+)$/m)?.[1]).toBe(admin);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("source tree", () => {
  const needles = forbiddenStrings();

  it.skipIf(needles.length === 0)("does not contain forbidden internal strings", () => {
    const hits = [];
    walk(root, (file) => {
      const text = readFileSync(file, "utf8");
      const lower = text.toLowerCase();
      if (needles.some((needle) => lower.includes(needle.toLowerCase()))) hits.push(path.relative(root, file));
    });
    expect(hits).toEqual([]);
  });
});

function walk(directory, visit) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".wrangler" || entry === "dist" || entry === "coverage") continue;
    const full = path.join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, visit);
    else if (
      /\.(mjs|ts|json|jsonc|sql|md|example|yml|yaml)$/.test(entry) ||
      entry === ".env.example" ||
      entry === ".gitignore" ||
      entry === ".public-sync-exclude" ||
      entry === ".npmrc"
    ) {
      visit(full);
    }
  }
}
