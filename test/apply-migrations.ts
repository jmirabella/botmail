import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { ensureDomains } from "../src/domains";

type TestEnv = Env & { TEST_MIGRATIONS: D1Migration[] };

const testEnv = env as TestEnv;
await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

const stamp = "2026-10-09T00:00:00.000Z";
const groupBots = [
  { id: "forge", displayName: "Forge" },
  { id: "vespa", displayName: "Vespa" },
  { id: "post", displayName: "Post" },
  { id: "glyph", displayName: "Glyph" },
  { id: "alexandria", displayName: "Alexandria" },
  { id: "athena", displayName: "Athena" },
  { id: "argus", displayName: "Argus" },
  { id: "vista", displayName: "Vista" },
  { id: "aegis", displayName: "Aegis" },
  { id: "quill", displayName: "Quill" },
  { id: "eggbot", displayName: "Eggbot" },
];
for (const bot of groupBots) {
  await testEnv.DB.prepare(
    `INSERT OR IGNORE INTO bots (id, display_name, address_local, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  )
    .bind(bot.id, bot.displayName, bot.id, stamp, stamp)
    .run();
}

// Group bots go in like rows from before migration 0004 (domain ''), so every test starts from the backfill.
await ensureDomains(testEnv);
