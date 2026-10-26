import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { renderWrangler } from "./scripts/render-wrangler.mjs";
import { validateGroupConfig } from "./scripts/group-config.mjs";

if (!existsSync(path.join(import.meta.dirname, "dashboard/dist/index.html"))) {
  execSync("npx vite build --config dashboard/vite.config.ts", { cwd: import.meta.dirname, stdio: "inherit" });
}

const group = validateGroupConfig(JSON.parse(readFileSync(path.join(import.meta.dirname, "test/group.config.json"), "utf8")));
writeFileSync(
  path.join(import.meta.dirname, "wrangler.jsonc"),
  renderWrangler(group, "00000000-0000-0000-0000-000000000000"),
);
writeFileSync(
  path.join(import.meta.dirname, ".dev.vars"),
  ["ADMIN_API_KEY=test-admin-key", `DATA_KEY=test-data-key`, `MAIL_DOMAIN=${group.mailDomain}`, ""].join("\n"),
);

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            MAIL_DOMAIN: group.mailDomain,
            ADMIN_API_KEY: "test-admin-key",
            DATA_KEY: "test-data-key",
            BRAND_NAME: group.brandName,
            BRAND_ACCENT: group.branding.accent,
            BRAND_LOGO: group.branding.logo,
            SEND_ALLOWLIST: group.sendAllowlist.join(","),
            SEND_POLICY: group.sendPolicy,
            INBOUND_RATE_LIMIT: String(group.inboundRateLimit),
            SPAM_SCORE_THRESHOLD: group.spamScoreThreshold === "off" ? "off" : String(group.spamScoreThreshold ?? 4),
            INBOUND_BOT_RATE_LIMIT: String(group.inboundBotRateLimit),
            INBOUND_AUTO_REPLY_LIMIT: String(group.inboundAutoReplyLimit),
            INBOUND_AUTO_REPLY_WINDOW: String(group.inboundAutoReplyWindow),
            OUTBOUND_DAILY_STAMP_LIMIT: String(group.outboundDailyStampLimit),
            CF_ACCESS_TEAM_DOMAIN: group.access.teamDomain,
            CF_ACCESS_AUD: group.access.aud,
            ACCESS_EMAIL_DOMAINS: group.access.allowedEmailDomains.join(","),
            ADMIN_HOST: group.adminHost,
            PUBLIC_HOST: group.publicHost,
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    env: {
      ADMIN_API_KEY: "test-admin-key",
      DATA_KEY: "test-data-key",
      MAIL_DOMAIN: group.mailDomain,
    },
  },
});
