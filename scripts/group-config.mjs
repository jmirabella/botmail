import { existsSync, readFileSync } from "node:fs";

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function loadGroupConfig(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  return validateGroupConfig(parsed);
}

export function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function validateGroupConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Config must be a JSON object");
  }
  const brandName = requiredString(input, "brandName").slice(0, 80);
  const workerName = requiredString(input, "workerName");
  const mailZone = requiredString(input, "mailZone").toLowerCase();
  const mailDomain = requiredString(input, "mailDomain").toLowerCase();
  const r2Bucket = requiredString(input, "r2Bucket");
  const d1Name = requiredString(input, "d1Name");
  const sendPolicy = input.sendPolicy === undefined ? "approval" : String(input.sendPolicy);
  if (sendPolicy !== "direct" && sendPolicy !== "approval") {
    throw new Error('sendPolicy must be "direct" or "approval"');
  }
  // inboundAuth (enforce/tag/off) used to be a config mode and was never read during delivery.
  // A config that still has the key keeps loading. The value is ignored.
  const inboundRateLimit = input.inboundRateLimit === undefined ? 20 : Number(input.inboundRateLimit);
  if (!Number.isInteger(inboundRateLimit) || inboundRateLimit < 1 || inboundRateLimit > 1000) {
    throw new Error("inboundRateLimit must be an integer from 1 to 1000");
  }
  let spamScoreThreshold = 4;
  if (input.spamScoreThreshold !== undefined) {
    if (typeof input.spamScoreThreshold === "string" && input.spamScoreThreshold.trim().toLowerCase() === "off") {
      spamScoreThreshold = "off";
    } else {
      const parsed = Number(input.spamScoreThreshold);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        throw new Error('spamScoreThreshold must be an integer from 1 to 5, or "off"');
      }
      spamScoreThreshold = parsed;
    }
  }
  const inboundBotRateLimit = input.inboundBotRateLimit === undefined ? 30 : Number(input.inboundBotRateLimit);
  if (!Number.isInteger(inboundBotRateLimit) || inboundBotRateLimit < 1 || inboundBotRateLimit > 1000) {
    throw new Error("inboundBotRateLimit must be an integer from 1 to 1000");
  }
  const inboundAutoReplyLimit = input.inboundAutoReplyLimit === undefined ? 20 : Number(input.inboundAutoReplyLimit);
  if (!Number.isInteger(inboundAutoReplyLimit) || inboundAutoReplyLimit < 1 || inboundAutoReplyLimit > 1000) {
    throw new Error("inboundAutoReplyLimit must be an integer from 1 to 1000");
  }
  const outboundDailyStampLimit = input.outboundDailyStampLimit === undefined ? 200 : Number(input.outboundDailyStampLimit);
  if (!Number.isInteger(outboundDailyStampLimit) || outboundDailyStampLimit < 1 || outboundDailyStampLimit > 10000) {
    throw new Error("outboundDailyStampLimit must be an integer from 1 to 10000");
  }
  const inboundAutoReplyWindow = input.inboundAutoReplyWindow === undefined ? 3600 : Number(input.inboundAutoReplyWindow);
  if (!Number.isInteger(inboundAutoReplyWindow) || inboundAutoReplyWindow < 60 || inboundAutoReplyWindow > 604800) {
    throw new Error("inboundAutoReplyWindow must be an integer number of seconds from 60 to 604800");
  }
  if (!SLUG.test(workerName)) throw new Error("workerName must be a lowercase slug");
  if (!SLUG.test(r2Bucket)) throw new Error("r2Bucket must be a lowercase slug");
  if (!SLUG.test(d1Name)) throw new Error("d1Name must be a lowercase slug");
  if (!DNS_NAME.test(mailZone)) throw new Error("mailZone must be a DNS name");
  if (!DNS_NAME.test(mailDomain)) throw new Error("mailDomain must be a DNS name");
  if (mailDomain !== mailZone && !mailDomain.endsWith(`.${mailZone}`)) {
    throw new Error("mailDomain must be the zone or a subdomain of mailZone");
  }
  if (!Array.isArray(input.sendAllowlist)) throw new Error("sendAllowlist must be an array of emails or domains");
  const sendAllowlist = input.sendAllowlist.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  const adminHost = String(input.adminHost ?? "").trim().toLowerCase();
  const publicHost = String(input.publicHost ?? "").trim().toLowerCase();
  const accessInput = input.access && typeof input.access === "object" ? input.access : {};
  const brandingInput = input.branding && typeof input.branding === "object" ? input.branding : {};
  const cfAccessTeamDomain = String(accessInput.teamDomain ?? input.cfAccessTeamDomain ?? "").trim().toLowerCase();
  const cfAccessAud = String(accessInput.aud ?? input.cfAccessAud ?? "").trim();
  const allowedEmailDomains = Array.isArray(accessInput.allowedEmailDomains)
    ? accessInput.allowedEmailDomains.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
    : [];
  if (adminHost && !DNS_NAME.test(adminHost)) throw new Error("adminHost must be a DNS name");
  if (adminHost && adminHost !== mailZone && !adminHost.endsWith(`.${mailZone}`)) {
    throw new Error("adminHost must be the zone or a subdomain of mailZone");
  }
  if (adminHost && allowedEmailDomains.length === 0) {
    throw new Error("access.allowedEmailDomains must list at least one domain when adminHost is set");
  }
  for (const domain of allowedEmailDomains) {
    if (!DNS_NAME.test(domain)) throw new Error(`allowed email domain ${domain} must be a DNS name`);
  }
  if (publicHost && !DNS_NAME.test(publicHost)) throw new Error("publicHost must be a DNS name");
  let workersDev = true;
  if (input.workersDev !== undefined) {
    if (typeof input.workersDev !== "boolean") throw new Error("workersDev must be true or false");
    workersDev = input.workersDev;
  }
  if (publicHost === "workers.dev" || publicHost.endsWith(".workers.dev")) workersDev = true;
  let uniqueBotNames = true;
  if (input.uniqueBotNames !== undefined) {
    if (typeof input.uniqueBotNames !== "boolean") throw new Error("uniqueBotNames must be true or false");
    uniqueBotNames = input.uniqueBotNames;
  }
  if (cfAccessTeamDomain && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cfAccessTeamDomain)) {
    throw new Error("access.teamDomain must be the Cloudflare Access team name");
  }
  const routing = input.routing === undefined ? "catch-all" : String(input.routing);
  if (routing !== "catch-all" && routing !== "literal") {
    throw new Error('routing must be "catch-all" or "literal"');
  }
  let outboundAllowlistOnly = false;
  if (input.outboundAllowlistOnly !== undefined) {
    if (typeof input.outboundAllowlistOnly !== "boolean") throw new Error("outboundAllowlistOnly must be true or false");
    outboundAllowlistOnly = input.outboundAllowlistOnly;
  }
  const logo = String(brandingInput.logo ?? "").trim();
  const accent = String(brandingInput.accent ?? "#7aa2ff").trim();
  if (logo && !logo.startsWith("https://")) throw new Error("branding.logo must be an https URL or empty");
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error("branding.accent must be a #rrggbb color");
  if (Object.prototype.hasOwnProperty.call(input, "bots")) {
    console.warn("bots in the config is deprecated and ignored. Add mailboxes on the dashboard. Setup does not create or change them.");
  }
  return {
    brandName,
    workerName,
    mailZone,
    mailDomain,
    r2Bucket,
    d1Name,
    sendPolicy,
    sendAllowlist,
    inboundRateLimit,
    spamScoreThreshold,
    inboundBotRateLimit,
    inboundAutoReplyLimit,
    inboundAutoReplyWindow,
    outboundDailyStampLimit,
    adminHost,
    publicHost,
    workersDev,
    uniqueBotNames,
    access: { teamDomain: cfAccessTeamDomain, aud: cfAccessAud, allowedEmailDomains },
    branding: { logo, accent },
    cfAccessTeamDomain,
    cfAccessAud,
    routing,
    outboundAllowlistOnly,
  };
}

/** Prod keeps bot-mail.state.json. Any other config gets a sibling state file, such as bot-mail.staging.state.json. */
export function pathsForConfig(configPath) {
  const name = String(configPath || "bot-mail.config.json").split("/").pop();
  if (name === "bot-mail.config.json" || name === "bot-mail.config.jsonc") {
    return { statePath: "bot-mail.state.json", secretsPath: ".bot-mail.secrets" };
  }
  const stem = name.replace(/\.jsonc?$/, "");
  return { statePath: `${stem}.state.json`, secretsPath: `.${stem}.secrets` };
}

export function mailDomainLabel(config) {
  if (config.mailDomain === config.mailZone) return "";
  return config.mailDomain.slice(0, -(config.mailZone.length + 1));
}

/** Same `.env` load setup uses, so deploy can see `CLOUDFLARE_ACCOUNT_ID` when the state file has no account id yet. */
export function loadDotEnv(path, env = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

function requiredString(input, key) {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}
