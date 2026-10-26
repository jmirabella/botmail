import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadGroupConfig, pathsForConfig } from "./group-config.mjs";
import { loadDotEnv, runLiteralRoute } from "./setup.mjs";

loadDotEnv(".env");
const configPath = process.env.BOT_MAIL_CONFIG || "bot-mail.config.json";
const secretsPath = process.env.BOTMAIL_SECRETS || pathsForConfig(configPath).secretsPath;

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
  if (message.result?.isError) return { error: payload || "create_bot failed" };
  try {
    return JSON.parse(payload);
  } catch {
    return { error: payload || "unparsed create_bot result" };
  }
}

const VALUE_FLAGS = new Set(["--name", "--origin", "--domain", "--id", "--notes"]);
const positional = process.argv.slice(2).filter((part, index, all) => !part.startsWith("--") && !VALUE_FLAGS.has(all[index - 1]));
const local = (positional[0] || "").trim().toLowerCase();
if (!local || local === "--help") {
  process.stderr.write(
    "Usage: npm run bot:add -- <name> [--domain desk.example.email] [--id herald.desk] [--name 'Display Name'] [--notes 'Owner and purpose'] [--origin https://<your-botmail-host>]\n",
  );
  process.exitCode = 1;
} else {
  const config = existsSync(configPath) ? loadGroupConfig(configPath) : null;
  const origin = (arg("--origin") || process.env.BOTMAIL_ORIGIN || (config?.publicHost ? `https://${config.publicHost}` : "")).replace(/\/$/, "");
  const secrets = readSecrets();
  const adminKey = process.env.ADMIN_API_KEY || secrets.get("ADMIN_API_KEY") || "";
  if (!origin || !adminKey) {
    process.stderr.write(`Set BOTMAIL_ORIGIN (or publicHost) and ADMIN_API_KEY in the environment or ${secretsPath}.\n`);
    process.exitCode = 1;
  } else {
    const args = { local_part: local, display_name: arg("--name") || local };
    if (arg("--domain")) args.domain = arg("--domain");
    if (arg("--id")) args.id = arg("--id");
    if (arg("--notes")) args.notes = arg("--notes");
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
        params: { name: "create_bot", arguments: args },
      }),
    });
    const body = toolResult(await response.text());
    if (!response.ok || !body.apiKey) {
      process.stderr.write(`bot add failed (HTTP ${response.status}): ${body.error || "no key returned"}\n`);
      process.exitCode = 1;
    } else {
      const id = body.id || local;
      secrets.set(id, body.apiKey);
      const file = `${[...secrets.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
      writeFileSync(secretsPath, file, { mode: 0o600 });
      chmodSync(secretsPath, 0o600);
      const mcp = `${origin}/mcp`;
      process.stdout.write(`Created ${body.address || id} (bot id ${id}). Stored the key in ${secretsPath} (mode 600). The key was not printed.\n`);
      if (config?.routing === "literal") {
        const address = body.address || `${local}@${config.mailDomain}`;
        try {
          await runLiteralRoute({
            config,
            routeAddress: address,
            token: process.env.CLOUDFLARE_API_TOKEN || "",
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
            lines: [],
            io: { write: (chunk) => process.stdout.write(chunk) },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "request failed";
          process.stderr.write(`Mailbox ${address} was created, but its routing rule was not: ${message}\n`);
          process.stderr.write(`Re-run: npm run setup -- --route ${address}\n`);
          process.exitCode = 1;
        }
      }
      process.stdout.write(`Primary: open https://${config?.adminHost || "<admin-host>"}/bots/${id} (Cloudflare Access sign-in) and use its Connect panel for a Grok Bot remote custom connector.\n`);
      process.stdout.write(`Connector URL: ${mcp}\n`);
      process.stdout.write(`Transport: Streamable HTTP. Header name: Authorization.\n`);
      process.stdout.write(`Fallback: bin/botmail-mcp ${id} ${mcp}\n`);
    }
  }
}
