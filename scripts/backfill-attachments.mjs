import { existsSync, readFileSync } from "node:fs";
import { loadGroupConfig } from "./group-config.mjs";

const secretsPath = process.env.BOTMAIL_SECRETS || ".bot-mail.secrets";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function readSecrets() {
  if (!existsSync(secretsPath)) return new Map();
  const map = new Map();
  for (const line of readFileSync(secretsPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return map;
}

function toolResult(text) {
  const trimmed = text.trim();
  const frame = trimmed.startsWith("{")
    ? trimmed
    : trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter((line) => line.startsWith("{"))
        .at(-1);
  if (!frame) return { error: trimmed.slice(0, 300) || "empty MCP response" };
  const message = JSON.parse(frame);
  if (message.error) return { error: message.error.message || "MCP error" };
  const payload = message.result?.content?.[0]?.text ?? "";
  if (message.result?.isError) return { error: payload || "backfill failed" };
  try {
    return JSON.parse(payload);
  } catch {
    return { error: payload || "unparsed backfill result" };
  }
}

if (process.argv.includes("--help")) {
  process.stderr.write("Usage: npm run attachments:backfill -- [--limit 25] [--origin https://public-host]\n");
  process.exitCode = 1;
} else {
  const configPath = process.env.BOT_MAIL_CONFIG || "bot-mail.config.json";
  const config = existsSync(configPath) ? loadGroupConfig(configPath) : null;
  const origin = (arg("--origin") || process.env.BOTMAIL_ORIGIN || (config?.publicHost ? `https://${config.publicHost}` : "")).replace(/\/$/, "");
  const secrets = readSecrets();
  const adminKey = process.env.ADMIN_API_KEY || secrets.get("ADMIN_API_KEY") || "";
  if (!origin || !adminKey) {
    process.stderr.write("Set BOTMAIL_ORIGIN (or publicHost) and ADMIN_API_KEY in the environment or .bot-mail.secrets.\n");
    process.exitCode = 1;
  } else {
    const limit = arg("--limit");
    const args = {};
    if (limit) args.limit = Number(limit);
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "backfill_attachments", arguments: args },
      }),
    });
    const body = toolResult(await response.text());
    if (!response.ok || body.error) {
      process.stderr.write(`attachment backfill failed (HTTP ${response.status}): ${body.error || "no result"}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Scanned ${body.scanned} stored messages. Extracted files from ${body.extracted}. Wrote ${body.attachments} attachments.\n`);
    }
  }
}
