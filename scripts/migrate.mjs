import { spawnSync } from "node:child_process";
import { writeDeployWrangler } from "./render-wrangler.mjs";

const remote = process.argv.includes("--remote");
const configPath = process.env.BOT_MAIL_CONFIG || "bot-mail.config.json";
let written;
try {
  written = writeDeployWrangler(configPath);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "deploy config failed"}\n`);
  process.exit(1);
}
const args = ["wrangler", "d1", "migrations", "apply", written.d1Name, remote ? "--remote" : "--local"];
const child = spawnSync("npx", args, { stdio: "inherit" });
process.exit(child.status ?? 1);
