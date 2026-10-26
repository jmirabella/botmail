import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGroupConfig } from "../scripts/group-config.mjs";
import { writeDeployWrangler } from "../scripts/render-wrangler.mjs";

const root = path.resolve(import.meta.dirname, "..");

function groupDocument(access) {
  const source = loadGroupConfig(path.join(root, "test/group.config.json"));
  return {
    brandName: source.brandName,
    workerName: source.workerName,
    mailZone: source.mailZone,
    mailDomain: source.mailDomain,
    r2Bucket: source.r2Bucket,
    d1Name: source.d1Name,
    sendPolicy: source.sendPolicy,
    sendAllowlist: source.sendAllowlist,
    adminHost: source.adminHost,
    publicHost: source.publicHost,
    access,
  };
}

describe("deploy wrangler config", () => {
  it("keeps the Access AUD and account id from the state file", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-deploy-"));
    const configPath = path.join(directory, "group.json");
    const statePath = path.join(directory, "group.state.json");
    const destination = path.join(directory, "wrangler.jsonc");
    try {
      writeFileSync(
        configPath,
        JSON.stringify(groupDocument({ teamDomain: "exampleteam", allowedEmailDomains: ["example.com"] })),
      );
      writeFileSync(
        statePath,
        JSON.stringify({
          d1DatabaseId: "11111111-1111-1111-1111-111111111111",
          accessAud: "aud-from-state",
          accountId: "acct-from-state",
          oauthKvId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      );
      writeDeployWrangler(configPath, { statePath, destination, env: {} });
      const text = readFileSync(destination, "utf8");
      expect(text).toContain('"CF_ACCESS_AUD": "aud-from-state"');
      expect(text).toContain('"CF_ACCOUNT_ID": "acct-from-state"');
      expect(text).toContain('"id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');

      writeFileSync(
        configPath,
        JSON.stringify(
          groupDocument({ teamDomain: "exampleteam", aud: "aud-from-config", allowedEmailDomains: ["example.com"] }),
        ),
      );
      writeFileSync(statePath, JSON.stringify({ d1DatabaseId: "11111111-1111-1111-1111-111111111111" }));
      writeDeployWrangler(configPath, {
        statePath,
        destination,
        env: { CLOUDFLARE_ACCOUNT_ID: "acct-from-env" },
      });
      const fallback = readFileSync(destination, "utf8");
      expect(fallback).toContain('"CF_ACCESS_AUD": "aud-from-config"');
      expect(fallback).toContain('"CF_ACCOUNT_ID": "acct-from-env"');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when the Access AUD cannot be resolved", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bot-mail-deploy-"));
    const configPath = path.join(directory, "group.json");
    const statePath = path.join(directory, "group.state.json");
    const destination = path.join(directory, "wrangler.jsonc");
    try {
      writeFileSync(
        configPath,
        JSON.stringify(groupDocument({ teamDomain: "exampleteam", allowedEmailDomains: ["example.com"] })),
      );
      writeFileSync(
        statePath,
        JSON.stringify({
          d1DatabaseId: "11111111-1111-1111-1111-111111111111",
          accountId: "acct-from-state",
        }),
      );
      expect(() => writeDeployWrangler(configPath, { statePath, destination, env: {} })).toThrow(/Refusing to deploy/);
      expect(() => writeDeployWrangler(configPath, { statePath, destination, env: {} })).toThrow(/CF_ACCESS_AUD/);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
