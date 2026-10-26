import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadDotEnv, loadGroupConfig, mailDomainLabel, pathsForConfig } from "./group-config.mjs";
import { renderWrangler, resolveInstallBindings } from "./render-wrangler.mjs";

export { loadDotEnv };

const API = "https://api.cloudflare.com/client/v4";
const STATE_PATH = "bot-mail.state.json";
const SECRETS_PATH = ".bot-mail.secrets";

export function describePlan(config) {
  const label = mailDomainLabel(config);
  const lines = [
    `Zone ${config.mailZone}: GET /zones?name=${encodeURIComponent(config.mailZone)}`,
    `R2 bucket ${config.r2Bucket}: npx wrangler r2 bucket info, then r2 bucket create if missing`,
    `D1 database ${config.d1Name}: npx wrangler d1 info --json, then d1 create if missing`,
    `KV namespace ${config.workerName}-oauth: npx wrangler kv namespace list, then kv namespace create if missing (OAUTH_KV holds connector grants)`,
    `Write wrangler.jsonc with the D1 id and no Email Routing addresses (${config.routing === "literal" ? "setup writes literal rules and leaves the catch-all alone" : "setup owns the catch-all"})`,
    "Build the dashboard: npm run build (Vite) into dashboard/dist, served as Workers static assets",
    `Enable Email Routing: POST /zones/{zone_id}/email/routing/enable`,
    `Plus-addressing: PATCH /zones/{zone_id}/email/routing {"support_subaddress":true}`,
  ];
  if (label) {
    lines.push(
      `Subdomain ${config.mailDomain}: POST /zones/{zone_id}/email/routing/dns {"name":"${config.mailDomain}"}`,
      `If that call is rejected, copy the apex routing MX and SPF onto ${config.mailDomain} with POST /zones/{zone_id}/dns_records`,
    );
  }
  lines.push(
    `Email Sending: GET/POST /zones/{zone_id}/email/sending/subdomains {"name":"${config.mailDomain}"}`,
    `Migrations: npx wrangler d1 migrations apply ${config.d1Name} --remote`,
    `Default domain: upsert ${config.mailDomain} into mail_domains. Setup does not write bots, routes, notes, or mail.`,
    "CF_API_TOKEN Worker secret for the dashboard Domains page: CLOUDFLARE_DOMAINS_API_TOKEN from .env, or the deploy token with --share-deploy-token. Without one the page shows manual steps.",
    `Deploy ${config.workerName}: npx wrangler deploy --secrets-file (mode 600, deleted after). The file contains only secrets the Worker does not already have.`,
  );
  if (config.routing === "literal") {
    lines.push(
      `Literal rules: GET /zones/{zone_id}/email/routing/rules, then POST or PUT one literal matcher per mailbox on ${config.mailDomain} action worker ${config.workerName}. The *@${config.mailZone} catch-all is not read or written.`,
      "Add a mailbox rule later: npm run setup -- --route <local-part>. Setup never deletes routing rules.",
    );
  } else {
    lines.push(
      `Catch-all *@${config.mailZone}: GET the current rule, then PUT /zones/{zone_id}/email/routing/rules/catch_all action worker ${config.workerName} only when it does not already send to a different Worker (--force-catch-all overrides). Setup never deletes routing rules. Wrangler does not touch Email Routing.`,
    );
  }
  lines.push(
    "Mailboxes: setup does not create, change, or remove bots. A fresh install has zero bots. Add them on the dashboard.",
    `Summary: print the dashboard URL and say to add bots there`,
  );
  if (config.adminHost) {
    lines.push(
      `Access application ${config.adminHost}: GET/POST /accounts/{account_id}/access/apps type self_hosted, then an email-domain include policy`,
      `Worker custom domain: POST /accounts/{account_id}/workers/domains hostname ${config.adminHost} service ${config.workerName}`,
    );
  }
  if (
    config.routing === "literal" &&
    config.publicHost &&
    !config.publicHost.endsWith(".workers.dev") &&
    config.publicHost !== config.adminHost
  ) {
    lines.push(
      `Worker custom domain: POST /accounts/{account_id}/workers/domains hostname ${config.publicHost} service ${config.workerName}`,
    );
  }
  return lines;
}

export function accessDeniedWarning(config, message) {
  if (!/\(403\)|\b403\b/.test(String(message ?? ""))) return [];
  const host = config.adminHost || "the admin host";
  return [
    `WARNING: Access was not created (403). The dashboard on ${host} is unprotected.`,
    "WARNING: The API token needs Access: Apps and Policies Edit and Access: Organizations Read.",
  ];
}

export function accessApplicationBody(config) {
  return {
    name: `${config.brandName} admin`,
    domain: config.adminHost,
    type: "self_hosted",
    session_duration: "24h",
    policies: [accessPolicyBody(config)],
  };
}

export function accessPolicyBody(config) {
  return {
    name: "Allowed email domains",
    decision: "allow",
    include: (config.access?.allowedEmailDomains || []).map((domain) => ({ email_domain: { domain } })),
  };
}

function catchAllFallback(config) {
  if (config.routing === "literal") {
    return `Literal routing does not change the *@${config.mailZone} catch-all. Add a mailbox rule with npm run setup -- --route <local-part>.`;
  }
  return `If the catch-all API fails: Email Routing → ${config.mailZone} → Routing rules → Catch-all address → action Send to a Worker → ${config.workerName}. Re-running setup only reads it back.`;
}

export function manualFallbacks(config) {
  const label = mailDomainLabel(config);
  const steps = [];
  if (label) {
    steps.push(
      `If subdomain routing DNS is not locked by Email Routing: Compute → Email Service → Email Routing → ${config.mailZone} → Settings → Subdomains → add "${label}". Catch-all stays *@${config.mailZone}.`,
    );
  }
  steps.push(
    catchAllFallback(config),
    `If Email Sending onboarding returns 403: Compute → Email Service → Email Sending → Onboard Domain → ${config.mailDomain}. That writes cf-bounce MX, SPF, DKIM, and _dmarc TXT.`,
    "Plus-addressing, if the settings PATCH fails: Email Routing → Settings → enable subaddressing.",
  );
  if (config.adminHost) {
    const domains = (config.access?.allowedEmailDomains || []).join(", ") || "(set access.allowedEmailDomains)";
    steps.push(
      `If the Access API fails: Zero Trust → Access → Applications → Add a self-hosted application for ${config.adminHost}. Policy Allow, include email domain ${domains}. Copy the application AUD into bot-mail.state.json as accessAud and re-run setup.`,
      `If the custom domain API fails: Workers → ${config.workerName} → Settings → Domains & Routes → Add ${config.adminHost}.`,
    );
  }
  return steps;
}

export function assertSupportedNode(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(
      `bot-mail setup needs Node.js 22 or newer. Wrangler refuses to run on older Node. This process is Node ${version}. Install Node 22 or newer, then run npm run setup again.`,
    );
  }
}

const REQUIRED_SECRET_NAMES = ["ADMIN_API_KEY", "DATA_KEY", "MAIL_DOMAIN"];

/**
 * The Worker's own Cloudflare token for the Domains page. A dedicated, narrower token is the default;
 * reusing the deploy token needs --share-deploy-token because it usually carries far more access.
 */
export function domainsApiToken({ env = {}, shareDeployToken = false, deployToken = "" }) {
  const dedicated = String(env.CLOUDFLARE_DOMAINS_API_TOKEN || "").trim();
  if (dedicated) return { token: dedicated, source: "CLOUDFLARE_DOMAINS_API_TOKEN" };
  if (shareDeployToken && deployToken) return { token: deployToken, source: "the deploy token (--share-deploy-token)" };
  return { token: "", source: "" };
}

export function secretsForDeploy({ existingNames, rotate = false, env = {}, saved = {}, mailDomain, domainsToken = "", random = () => randomBytes(32).toString("base64url") }) {
  const names = existingNames === null ? REQUIRED_SECRET_NAMES : existingNames;
  const upload = {};
  const issued = { adminKey: "", dataKey: "", generatedAdmin: false, generatedData: false };
  if (rotate || !names.includes("ADMIN_API_KEY")) {
    const chosen = chooseSecret(env.ADMIN_API_KEY, rotate ? "" : saved.ADMIN_API_KEY, random);
    issued.adminKey = chosen.value;
    issued.generatedAdmin = chosen.generated;
    upload.ADMIN_API_KEY = chosen.value;
  }
  if (rotate || !names.includes("DATA_KEY")) {
    const chosen = chooseSecret(env.DATA_KEY, rotate ? "" : saved.DATA_KEY, random);
    issued.dataKey = chosen.value;
    issued.generatedData = chosen.generated;
    upload.DATA_KEY = chosen.value;
  }
  if (rotate || !names.includes("MAIL_DOMAIN")) upload.MAIL_DOMAIN = mailDomain;
  if (domainsToken && (rotate || !names.includes("CF_API_TOKEN"))) upload.CF_API_TOKEN = domainsToken;
  return { upload, issued };
}

function chooseSecret(fromEnv, fromSaved, random) {
  if (fromEnv) return { value: fromEnv, generated: false };
  if (fromSaved) return { value: fromSaved, generated: false };
  return { value: random(), generated: true };
}

export function writeDeploySecretsFile(values, directory = tmpdir()) {
  const folder = mkdtempSync(join(directory, "bot-mail-secrets-"));
  chmodSync(folder, 0o700);
  const file = join(folder, "secrets.env");
  const body = `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function shredSecretsFile(file) {
  if (!file || !existsSync(file)) return;
  const size = statSync(file).size;
  writeFileSync(file, Buffer.alloc(Math.max(size, 1), 0));
  rmSync(file, { force: true });
  rmSync(dirname(file), { recursive: true, force: true });
}

export async function runSetup(options) {
  const config = options.config;
  const say = (line) => {
    options.lines.push(line);
    options.io?.write?.(`${line}\n`);
  };
  const manual = manualFallbacks(config);
  assertSupportedNode(options.nodeVersion);

  if (options.dryRun) {
    say(`dry-run for ${config.brandName}`);
    for (const line of describePlan(config)) say(`would ${line}`);
    say("manual fallbacks, if a live step cannot be automated:");
    for (const step of manual) say(`- ${step}`);
    say("dry-run: no Cloudflare calls were made");
    return { ok: true, manual };
  }

  requireCredentials(options);
  if (options.teardown) return teardown(options, config, say);

  const zone = await findZone(options, config.mailZone);
  say(`zone ${config.mailZone} ${zone.id}`);

  await ensureR2(options, config, say);
  const databaseId = await ensureD1(options, config, say);
  const previous = readState(options.statePath ?? STATE_PATH);
  const oauthKvId = await ensureKv(options, config, say, previous.oauthKvId || "");
  const accountId = options.accountId || previous.accountId || "";
  let access = {
    id: previous.accessAppId || "",
    aud: resolveInstallBindings(config, previous, { accountId }).accessAud || "",
  };
  if (config.adminHost) {
    try {
      access = await ensureAccessApplication(options, config, access.aud);
      say(`access app ${access.id || "(created)"} for ${config.adminHost}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      say(`access application failed: ${message}`);
      for (const line of accessDeniedWarning(config, message)) say(line);
      say(`manual: ${manual.find((step) => step.includes("Access")) || "create the Access application in Zero Trust"}`);
    }
  }
  const install = {
    d1DatabaseId: databaseId,
    zoneId: zone.id,
    accessAppId: access.id,
    accessAud: access.aud,
    oauthKvId,
    accountId,
  };
  const extras = resolveInstallBindings(config, install);
  writeFileSync(
    options.statePath ?? STATE_PATH,
    `${JSON.stringify({ ...install, accessAud: extras.accessAud || "", accountId: extras.accountId || accountId }, null, 2)}\n`,
  );
  const wranglerPath = options.wranglerPath ?? "wrangler.jsonc";
  writeFileSync(wranglerPath, renderWrangler(config, databaseId, extras));
  say(`wrote ${wranglerPath}`);
  const built = await (options.buildDashboard ?? buildDashboard)();
  if (built.code !== 0) throw new Error(`dashboard build failed: ${built.stderr || built.stdout}`);
  say("built dashboard into dashboard/dist");

  await enableRouting(options, zone.id, config, say, manual);
  await onboardSending(options, zone.id, config, say, manual);

  const migrated = await wrangler(options, ["d1", "migrations", "apply", config.d1Name, "--remote"]);
  if (migrated.code !== 0) throw new Error(`d1 migrations apply failed: ${migrated.stderr || migrated.stdout}`);
  say("applied D1 migrations");
  await seedDefaultDomain(options, databaseId, config, say);

  const existingNames = await listSecretNames(options, config, say);
  const saved = readSecretsMap(options.secretsPath ?? SECRETS_PATH);
  const domainsToken = domainsApiToken({
    env: options.env ?? {},
    shareDeployToken: Boolean(options.shareDeployToken),
    deployToken: options.token,
  });
  const prepared = secretsForDeploy({
    existingNames,
    rotate: Boolean(options.rotateSecrets),
    env: options.env ?? {},
    saved,
    mailDomain: config.mailDomain,
    domainsToken: domainsToken.token,
  });
  if (prepared.upload.CF_API_TOKEN) say(`CF_API_TOKEN for the Domains page comes from ${domainsToken.source}`);
  else if (existingNames?.includes("CF_API_TOKEN")) say("CF_API_TOKEN already set; the Domains page can provision domains");
  else say("no CF_API_TOKEN: the Domains page will show manual steps. Set CLOUDFLARE_DOMAINS_API_TOKEN in .env and re-run, or see the README.");
  rememberSecrets(options, {
    adminKey: prepared.issued.generatedAdmin ? prepared.issued.adminKey : "",
    dataKey: prepared.issued.generatedData ? prepared.issued.dataKey : "",
    mailDomain: config.mailDomain,
  });
  const deployArgs = ["deploy", "--config", wranglerPath];
  let secretsFile = "";
  if (Object.keys(prepared.upload).length > 0) {
    secretsFile = writeDeploySecretsFile(prepared.upload, options.tempDir);
    deployArgs.push("--secrets-file", secretsFile);
    say("deploy will upload the secrets that are not on the Worker yet");
  } else {
    say("Worker secrets already set; deploy will not replace them");
  }
  let deployed;
  try {
    deployed = await wrangler(options, deployArgs);
  } finally {
    shredSecretsFile(secretsFile);
  }
  const deployOutput = `${deployed.stdout ?? ""}\n${deployed.stderr ?? ""}`;
  const deployOk = deployed.code === 0;
  if (!deployOk) {
    say(`deploy failed: ${deployOutput.trim()}`);
    say("manual: run npm run deploy in a terminal and read the Wrangler error.");
  } else {
    say(`deployed ${config.workerName}`);
  }

  if (config.routing === "literal") {
    const addresses = await mailboxAddresses(options, databaseId, config);
    if (addresses.length === 0) {
      say(
        `literal routing: no mailbox on ${config.mailDomain} yet. The *@${config.mailZone} catch-all was not changed. After you add a bot, run npm run setup -- --route <local-part>.`,
      );
    } else {
      await ensureLiteralRules(options, zone.id, config, addresses, say);
    }
  } else {
    await ensureCatchAll(options, zone.id, config, say);
  }
  if (config.adminHost) {
    try {
      await ensureWorkerDomain(options, config, say);
    } catch (error) {
      say(`custom domain failed: ${error instanceof Error ? error.message : "request failed"}`);
      say(`manual: ${manual.find((step) => step.includes("Domains")) || "attach the admin hostname on the Worker"}`);
    }
  }
  await ensurePublicHost(options, config, say);
  const issued = prepared.issued;
  if (options.rotateKeys) say("Bot API keys are minted on the dashboard or by the admin MCP. Setup does not rotate them.");
  const origin = await workerOrigin(options, config, say);

  say("");
  say(config.brandName);
  const mcpOrigin = config.publicHost ? `https://${config.publicHost}` : origin;
  const adminOrigin = config.adminHost ? `https://${config.adminHost}` : origin;
  say(`MCP  ${mcpOrigin}/mcp`);
  say(`Dashboard ${adminOrigin}/`);
  say(`Add bots at ${adminOrigin}/bots. Setup does not create mailboxes.`);
  say(`Default mail domain ${config.mailDomain}. Add more on ${adminOrigin}/domains`);
  if (issued.generatedAdmin) say(`ADMIN_API_KEY ${issued.adminKey}`);
  else say("ADMIN_API_KEY already set; not printed");
  say(`secrets file ${options.secretsPath ?? SECRETS_PATH}`);
  return { ok: deployOk, manual, origin };
}

async function teardown(options, config, say) {
  if (!options.yes) throw new Error("teardown requires --yes");
  const zone = await findZone(options, config.mailZone);
  const removed = await wrangler(options, ["delete", config.workerName, "--force", "--config", options.wranglerPath ?? "wrangler.jsonc"]);
  say(removed.code === 0 ? `deleted worker ${config.workerName}` : `worker delete failed: ${(removed.stderr || removed.stdout).trim()}`);
  if (config.routing === "literal") {
    say("literal routing: left the zone catch-all and every routing rule in place");
  } else {
    try {
      await cf(options, "PUT", `/zones/${zone.id}/email/routing/rules/catch_all`, {
        enabled: false,
        matchers: [{ type: "all" }],
        actions: [{ type: "drop", value: [] }],
      });
      say("disabled the zone catch-all");
    } catch (error) {
      say(`catch-all disable failed: ${error instanceof Error ? error.message : "request failed"}`);
    }
    await disableExtraCatchAlls(options, config, zone.id, say);
  }
  if (!options.includeData) {
    say("left the D1 database, R2 bucket, OAUTH_KV namespace, and Email Routing DNS in place. Re-run with --include-data to delete D1, R2, and KV.");
    return { ok: true, manual: [] };
  }
  const state = readState(options.statePath ?? STATE_PATH);
  if (state.d1DatabaseId) {
    await cf(options, "DELETE", `/accounts/${options.accountId}/d1/database/${state.d1DatabaseId}`);
    say(`deleted D1 ${config.d1Name}`);
  }
  await cf(options, "DELETE", `/accounts/${options.accountId}/r2/buckets/${config.r2Bucket}`);
  say(`deleted R2 ${config.r2Bucket}`);
  if (state.oauthKvId) {
    await cf(options, "DELETE", `/accounts/${options.accountId}/storage/kv/namespaces/${state.oauthKvId}`);
    say(`deleted KV ${config.workerName}-oauth`);
  }
  return { ok: true, manual: [] };
}

/** Zones added on the Domains page get their own catch-all. Turn those off too, but only when they point here. */
async function disableExtraCatchAlls(options, config, mainZoneId, say) {
  const state = readState(options.statePath ?? STATE_PATH);
  if (!state.d1DatabaseId) return;
  let zones = [];
  try {
    const rows = await d1(options, state.d1DatabaseId, {
      sql: "SELECT DISTINCT zone_id, zone_name FROM mail_domains WHERE zone_id IS NOT NULL AND zone_id != ?",
      params: [mainZoneId],
    });
    zones = Array.isArray(rows) ? rows : [];
  } catch (error) {
    say(`could not read extra domains: ${error instanceof Error ? error.message : "request failed"}`);
    return;
  }
  for (const row of zones) {
    try {
      const rule = await cf(options, "GET", `/zones/${row.zone_id}/email/routing/rules/catch_all`);
      const action = rule?.actions?.[0];
      const targets = Array.isArray(action?.value) ? action.value : [];
      if (!(action?.type === "worker" && targets.includes(config.workerName))) {
        say(`left the ${row.zone_name} catch-all alone; it does not send to ${config.workerName}`);
        continue;
      }
      await cf(options, "PUT", `/zones/${row.zone_id}/email/routing/rules/catch_all`, {
        enabled: false,
        matchers: [{ type: "all" }],
        actions: [{ type: "drop", value: [] }],
      });
      say(`disabled the ${row.zone_name} catch-all`);
    } catch (error) {
      say(`catch-all disable failed for ${row.zone_name}: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
}

export async function runStatus(options) {
  assertSupportedNode(options.nodeVersion);
  const config = options.config;
  requireCredentials(options);
  const say = (line) => {
    options.lines.push(line);
    options.io?.write?.(`${line}\n`);
  };
  const zone = await findZone(options, config.mailZone);
  say(`zone ${zone.id} ${zone.status ?? "found"}`);
  const bucket = await wrangler(options, ["r2", "bucket", "info", config.r2Bucket, "--json"]);
  say(bucket.code === 0 ? `r2 ${config.r2Bucket} present` : `r2 ${config.r2Bucket} missing`);
  const database = await wrangler(options, ["d1", "info", config.d1Name, "--json"]);
  say(database.code === 0 ? `d1 ${config.d1Name} present` : `d1 ${config.d1Name} missing`);
  try {
    const routing = await cf(options, "GET", `/zones/${zone.id}/email/routing`);
    say(`email routing enabled=${Boolean(routing?.enabled)} subaddress=${Boolean(routing?.support_subaddress)}`);
  } catch (error) {
    say(`email routing status unavailable: ${error instanceof Error ? error.message : "request failed"}`);
  }
  try {
    const sending = await cf(options, "GET", `/zones/${zone.id}/email/sending/subdomains`);
    const names = (Array.isArray(sending) ? sending : []).map((row) => row.name).join(", ") || "(none)";
    say(`sending subdomains ${names}`);
  } catch (error) {
    say(`sending status unavailable: ${error instanceof Error ? error.message : "request failed"}`);
  }
  try {
    const secrets = await cf(options, "GET", `/accounts/${options.accountId}/workers/scripts/${config.workerName}/secrets`);
    const names = (Array.isArray(secrets) ? secrets : []).map((row) => row.name).sort().join(", ") || "(none)";
    say(`worker secrets ${names}`);
  } catch (error) {
    say(`worker secrets unavailable: ${error instanceof Error ? error.message : "request failed"}`);
  }
  return { ok: true };
}

async function findZone(options, name) {
  const zones = await cf(options, "GET", `/zones?name=${encodeURIComponent(name)}&per_page=5`);
  const zone = (Array.isArray(zones) ? zones : []).find((item) => item.name === name);
  if (!zone?.id) throw new Error(`Zone ${name} was not found in this account. Add it to Cloudflare before setup.`);
  return zone;
}

async function ensureR2(options, config, say) {
  const info = await wrangler(options, ["r2", "bucket", "info", config.r2Bucket, "--json"]);
  if (info.code === 0) {
    say(`r2 ${config.r2Bucket} already exists`);
    return;
  }
  const created = await wrangler(options, ["r2", "bucket", "create", config.r2Bucket]);
  if (created.code !== 0 && !/already exists/i.test(`${created.stdout}\n${created.stderr}`)) {
    throw new Error(`r2 bucket create failed: ${created.stderr || created.stdout}`);
  }
  say(`r2 ${config.r2Bucket} ready`);
}

async function ensureKv(options, config, say, previousId) {
  const title = `${config.workerName}-oauth`;
  if (previousId) {
    say(`kv ${title} ${previousId}`);
    return previousId;
  }
  const listed = await wrangler(options, ["kv", "namespace", "list"]);
  const rows = listed.code === 0 ? parseJsonList(listed.stdout) : [];
  const found = rows.find((row) => row && (row.title === title || row.title === `${config.workerName}-${title}`));
  if (found?.id) {
    say(`kv ${title} ${found.id}`);
    return found.id;
  }
  const created = await wrangler(options, ["kv", "namespace", "create", title]);
  if (created.code !== 0) throw new Error(`kv namespace create failed: ${created.stderr || created.stdout}`);
  const id = `${created.stdout}\n${created.stderr}`.match(/[0-9a-f]{32}/)?.[0] || "";
  if (!id) throw new Error("kv namespace create succeeded but did not return an id");
  say(`kv ${title} created ${id}`);
  return id;
}

async function ensureD1(options, config, say) {
  const existing = await readD1Id(options, config.d1Name);
  if (existing) {
    say(`d1 ${config.d1Name} ${existing}`);
    return existing;
  }
  const created = await wrangler(options, ["d1", "create", config.d1Name]);
  if (created.code !== 0) throw new Error(`d1 create failed: ${created.stderr || created.stdout}`);
  const id = await readD1Id(options, config.d1Name);
  if (!id) throw new Error("d1 create succeeded but d1 info did not return a uuid");
  say(`d1 ${config.d1Name} created ${id}`);
  return id;
}

async function readD1Id(options, name) {
  const info = await wrangler(options, ["d1", "info", name, "--json"]);
  if (info.code !== 0) return "";
  const parsed = parseJson(info.stdout);
  return parsed?.uuid || parsed?.database_id || "";
}

async function enableRouting(options, zoneId, config, say, manual) {
  try {
    const current = await cf(options, "GET", `/zones/${zoneId}/email/routing`);
    if (!current?.enabled) {
      await cf(options, "POST", `/zones/${zoneId}/email/routing/enable`);
      say("enabled Email Routing on the zone");
    } else {
      say("Email Routing already enabled");
    }
  } catch (error) {
    say(`Email Routing enable failed: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: ${manual[0]}`);
  }
  try {
    await cf(options, "PATCH", `/zones/${zoneId}/email/routing`, { support_subaddress: true });
    say("plus-addressing enabled");
  } catch (error) {
    say(`plus-addressing update failed: ${error instanceof Error ? error.message : "request failed"}`);
  }
  const label = mailDomainLabel(config);
  if (!label) return;
  try {
    await cf(options, "POST", `/zones/${zoneId}/email/routing/dns`, { name: config.mailDomain });
    say(`requested routing DNS for ${config.mailDomain}`);
    return;
  } catch (error) {
    say(`routing DNS for ${config.mailDomain} was not accepted: ${error instanceof Error ? error.message : "request failed"}`);
  }
  try {
    await copyRoutingDns(options, zoneId, config);
    say(`copied apex routing MX and SPF onto ${config.mailDomain}`);
    say(`manual: ${manual[0]}`);
  } catch (error) {
    say(`could not copy routing DNS: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: ${manual[0]}`);
  }
}

async function copyRoutingDns(options, zoneId, config) {
  const records = await cf(options, "GET", `/zones/${zoneId}/email/routing/dns`);
  const wanted = (Array.isArray(records) ? records : []).filter((record) => record.type === "MX" || record.type === "TXT");
  for (const record of wanted) {
    const name = rewriteRecordName(record.name, config.mailZone, config.mailDomain);
    if (!name || (record.type === "TXT" && !/spf1/i.test(String(record.content ?? "")))) continue;
    const existing = await cf(
      options,
      "GET",
      `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(name)}&per_page=100`,
    );
    const rows = Array.isArray(existing) ? existing : [];
    const found = rows.some((row) => row.content === record.content && (record.type !== "MX" || row.priority === record.priority));
    if (found) continue;
    await cf(options, "POST", `/zones/${zoneId}/dns_records`, {
      type: record.type,
      name,
      content: record.content,
      ttl: record.ttl || 1,
      ...(record.type === "MX" ? { priority: record.priority } : {}),
    });
  }
}

function rewriteRecordName(name, zone, mailDomain) {
  if (!name || name === "@" || name === zone) return mailDomain;
  if (name.endsWith(`.${zone}`)) {
    const prefix = name.slice(0, -(zone.length + 1));
    return `${prefix}.${mailDomain}`;
  }
  return "";
}

async function onboardSending(options, zoneId, config, say, manual) {
  try {
    const listed = await cf(options, "GET", `/zones/${zoneId}/email/sending/subdomains`);
    const rows = Array.isArray(listed) ? listed : [];
    const found = rows.find((row) => row.name === config.mailDomain && row.enabled);
    if (found) {
      say(`Email Sending already enabled for ${config.mailDomain}`);
      return;
    }
    const created = await cf(options, "POST", `/zones/${zoneId}/email/sending/subdomains`, { name: config.mailDomain });
    say(`Email Sending onboarded ${created?.name || config.mailDomain} return-path ${created?.return_path_domain || "cf-bounce"}`);
  } catch (error) {
    say(`Email Sending onboarding failed: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: ${manual[1]}`);
  }
}

/** `keep` when this Worker already has the enabled catch-all. `refuse` when another Worker has it. */
export function catchAllDecision(rule, workerName) {
  const action = rule?.actions?.[0];
  const targets = Array.isArray(action?.value) ? action.value.map((item) => String(item)) : [];
  if (rule?.enabled && action?.type === "worker" && targets.includes(workerName)) return { action: "keep", foreign: [] };
  const foreign = action?.type === "worker" ? targets.filter((name) => name && name !== workerName) : [];
  if (foreign.length > 0 && !targets.includes(workerName)) return { action: "refuse", foreign };
  return { action: "write", foreign };
}

async function ensureCatchAll(options, zoneId, config, say) {
  let rule;
  try {
    rule = await cf(options, "GET", `/zones/${zoneId}/email/routing/rules/catch_all`);
  } catch (error) {
    say(`catch-all update failed: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: ${catchAllFallback(config)}`);
    return;
  }
  const decision = catchAllDecision(rule, config.workerName);
  if (decision.action === "keep") {
    say("catch-all already sends to this worker");
    return;
  }
  if (decision.action === "refuse" && !options.forceCatchAll) {
    throw new Error(
      `Refusing to change the *@${config.mailZone} catch-all: it already sends to ${decision.foreign.join(", ")}, not ${config.workerName}. Re-run with --force-catch-all to take it. Setup does not delete routing rules.`,
    );
  }
  try {
    await cf(options, "PUT", `/zones/${zoneId}/email/routing/rules/catch_all`, {
      enabled: true,
      name: `${config.workerName} catch-all`,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [config.workerName] }],
    });
    say("catch-all updated to this worker");
  } catch (error) {
    say(`catch-all update failed: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: ${catchAllFallback(config)}`);
  }
}

export function routingAddress(config, input) {
  let raw = String(input || "").trim().toLowerCase();
  if (!raw || raw.startsWith("--")) throw new Error("--route needs a local-part or mailbox address");
  if (!raw.includes("@")) raw = `${raw}@${config.mailDomain}`;
  const at = raw.lastIndexOf("@");
  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  if (!local || !domain) throw new Error(`Invalid routing address ${input}`);
  if (domain !== config.mailZone && !domain.endsWith(`.${config.mailZone}`)) {
    throw new Error(`${local}@${domain} is outside ${config.mailZone}, so setup will not add a routing rule for it`);
  }
  return `${local}@${domain}`;
}

function literalMatcherAddress(rule) {
  const matchers = Array.isArray(rule?.matchers) ? rule.matchers : [];
  const matcher = matchers.find((item) => item?.type === "literal" && item.value);
  return matcher ? String(matcher.value).trim().toLowerCase() : "";
}

function ruleId(rule) {
  return String(rule?.id || rule?.tag || "");
}

/** `keep` when an enabled literal rule already sends only to this Worker. Never plans a delete. */
export function planLiteralRule(rules, address, workerName) {
  const related = (Array.isArray(rules) ? rules : []).filter((rule) => literalMatcherAddress(rule) === address);
  const targetsOf = (rule) => {
    const action = rule?.actions?.[0];
    return action?.type === "worker" && Array.isArray(action.value) ? action.value.map(String) : null;
  };
  const ours = related.find((rule) => {
    const targets = targetsOf(rule);
    return targets && targets.length > 0 && targets.every((name) => name === workerName);
  });
  if (ours?.enabled) return { op: "keep", id: ruleId(ours), targets: [workerName] };
  const foreign = related.find((rule) => rule !== ours);
  if (foreign) {
    const targets = targetsOf(foreign);
    return {
      op: "refuse",
      id: ruleId(foreign),
      targets: targets && targets.length ? targets : [foreign.actions?.[0]?.type || "another target"],
    };
  }
  if (ours) return { op: "update", id: ruleId(ours), targets: [workerName] };
  return { op: "create", id: "", targets: [] };
}

function literalRuleBody(config, address) {
  return {
    name: `${config.workerName} ${address}`.slice(0, 256),
    enabled: true,
    matchers: [{ type: "literal", field: "to", value: address }],
    actions: [{ type: "worker", value: [config.workerName] }],
  };
}

async function listRoutingRules(options, zoneId) {
  const rules = [];
  const seen = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const batch = await cf(options, "GET", `/zones/${zoneId}/email/routing/rules?per_page=50&page=${page}`);
    const rows = Array.isArray(batch) ? batch : [];
    let added = 0;
    for (const row of rows) {
      const id = ruleId(row);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      rules.push(row);
      added += 1;
    }
    if (rows.length < 50 || added === 0) break;
  }
  return rules;
}

export async function ensureLiteralRules(options, zoneId, config, addresses, say) {
  const rules = await listRoutingRules(options, zoneId);
  for (const address of addresses) {
    const plan = planLiteralRule(rules, address, config.workerName);
    if (plan.op === "keep") {
      say(`literal rule for ${address} already sends to this worker`);
      continue;
    }
    if (plan.op === "refuse") {
      throw new Error(
        `Refusing to change the routing rule for ${address}: it already sends to ${plan.targets.join(", ")}, not ${config.workerName}. Setup does not delete routing rules.`,
      );
    }
    const body = literalRuleBody(config, address);
    if (plan.op === "update") {
      if (!plan.id) throw new Error(`Routing rule for ${address} has no id, so setup will not create a second one.`);
      await cf(options, "PUT", `/zones/${zoneId}/email/routing/rules/${plan.id}`, body);
      say(`literal rule updated for ${address}`);
      continue;
    }
    const created = await cf(options, "POST", `/zones/${zoneId}/email/routing/rules`, body);
    say(`literal rule created for ${address}`);
    if (created && typeof created === "object") rules.push(created);
  }
}

async function mailboxAddresses(options, databaseId, config) {
  const rows = await d1(options, databaseId, {
    sql: "SELECT id, address_local, domain FROM bots WHERE deleted_at IS NULL",
    params: [],
  });
  const addresses = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.address_local || !row?.domain) continue;
    if (row.id === "_unrouted" || String(row.address_local).startsWith("_")) continue;
    const domain = String(row.domain).toLowerCase();
    if (domain !== config.mailZone && !domain.endsWith(`.${config.mailZone}`)) continue;
    addresses.push(`${String(row.address_local).toLowerCase()}@${domain}`);
  }
  return [...new Set(addresses)];
}

export async function runLiteralRoute(options) {
  if (options.config.routing !== "literal") {
    throw new Error(`routing is "${options.config.routing || "catch-all"}". --route applies only when routing is "literal".`);
  }
  assertSupportedNode(options.nodeVersion);
  requireCredentials(options);
  const say = (line) => {
    options.lines.push(line);
    options.io?.write?.(`${line}\n`);
  };
  const address = routingAddress(options.config, options.routeAddress);
  const zone = await findZone(options, options.config.mailZone);
  await ensureLiteralRules(options, zone.id, options.config, [address], say);
  return { ok: true, address };
}

async function listSecretNames(options, config, say) {
  try {
    const listed = await cf(options, "GET", `/accounts/${options.accountId}/workers/scripts/${config.workerName}/secrets`);
    return (Array.isArray(listed) ? listed : []).map((row) => row.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    if (/10007|\(404\)|does not exist|not found/i.test(message)) return [];
    say(`could not list Worker secrets (${message}). Existing keys will be left in place.`);
    return null;
  }
}

/** Records the default domain only. The Worker backfills empty bot and route domains; setup never writes those tables. */
export function defaultDomainStatements(mailDomain, stamp) {
  return [
    {
      sql: "UPDATE mail_domains SET is_default = 0, updated_at = ? WHERE is_default = 1 AND domain != ?",
      params: [stamp, mailDomain],
    },
    {
      sql: `INSERT INTO mail_domains (domain, is_default, enabled, status, created_at, updated_at)
            VALUES (?, 1, 1, '{}', ?, ?)
            ON CONFLICT(domain) DO UPDATE SET is_default = 1, enabled = 1, updated_at = excluded.updated_at`,
      params: [mailDomain, stamp, stamp],
    },
  ];
}

async function seedDefaultDomain(options, databaseId, config, say) {
  for (const statement of defaultDomainStatements(config.mailDomain, new Date().toISOString())) {
    await d1(options, databaseId, statement);
  }
  say(`default domain ${config.mailDomain} recorded. Setup does not change bots, routes, or mail.`);
}

export async function ensureAccessApplication(options, config, audHint = "") {
  const accountPath = `/accounts/${options.accountId}/access/apps`;
  const listed = await cf(options, "GET", accountPath);
  const apps = Array.isArray(listed) ? listed : [];
  const host = String(config.adminHost).toLowerCase();
  const existing = apps.find((app) => appMatchesHost(app, host));
  const body = accessApplicationBody(config);
  const app = existing?.id
    ? await cf(options, "PUT", `${accountPath}/${existing.id}`, body)
    : await cf(options, "POST", accountPath, body);
  const appId = app?.id || existing?.id || "";
  if (appId) {
    try {
      await syncAccessPolicy(options, appId, config);
    } catch {
      // The application itself is enough to capture aud. A policy mismatch is reported by the caller.
    }
  }
  return { id: appId, aud: app?.aud || existing?.aud || audHint || "" };
}

async function syncAccessPolicy(options, appId, config) {
  const policyPath = `/accounts/${options.accountId}/access/apps/${appId}/policies`;
  const listed = await cf(options, "GET", policyPath);
  const policies = Array.isArray(listed) ? listed : [];
  const body = accessPolicyBody(config);
  const current = policies.find((policy) => policy.name === body.name) || policies.find((policy) => policy.decision === "allow");
  if (current?.id) await cf(options, "PUT", `${policyPath}/${current.id}`, { ...body, precedence: current.precedence ?? 1 });
  else await cf(options, "POST", policyPath, { ...body, precedence: 1 });
}

function appMatchesHost(app, host) {
  if (String(app?.domain || "").toLowerCase() === host) return true;
  const destinations = Array.isArray(app?.destinations) ? app.destinations : [];
  return destinations.some((item) => String(item?.hostname || item || "").toLowerCase() === host);
}

async function ensureWorkerDomain(options, config, say, hostname = config.adminHost) {
  const path = `/accounts/${options.accountId}/workers/domains`;
  const listed = await cf(options, "GET", path);
  const rows = Array.isArray(listed) ? listed : [];
  const found = rows.find((row) => String(row.hostname || "").toLowerCase() === hostname);
  if (found) {
    say(`custom domain ${hostname} already attached`);
    return;
  }
  try {
    await cf(options, "POST", path, {
      hostname,
      service: config.workerName,
      environment: "production",
    });
    say(`custom domain ${hostname} attached`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    if (/already|duplicate|exists/i.test(message)) {
      say(`custom domain ${hostname} already attached`);
      return;
    }
    throw error;
  }
}

async function ensurePublicHost(options, config, say) {
  if (config.routing !== "literal" || !config.publicHost) return;
  if (config.publicHost.endsWith(".workers.dev") || config.publicHost === config.adminHost) return;
  try {
    await ensureWorkerDomain(options, config, say, config.publicHost);
  } catch (error) {
    say(`custom domain failed: ${error instanceof Error ? error.message : "request failed"}`);
    say(`manual: Workers → ${config.workerName} → Settings → Domains & Routes → Add ${config.publicHost}.`);
  }
}

async function workerOrigin(options, config, say) {
  try {
    const subdomain = await cf(options, "GET", `/accounts/${options.accountId}/workers/subdomain`);
    if (subdomain?.subdomain) return `https://${config.workerName}.${subdomain.subdomain}.workers.dev`;
  } catch (error) {
    say(`workers.dev subdomain lookup failed: ${error instanceof Error ? error.message : "request failed"}`);
  }
  say("manual: copy the workers.dev or custom-domain host from the Worker overview.");
  return `https://${config.workerName}.<account>.workers.dev`;
}

async function d1(options, databaseId, query) {
  const result = await cf(options, "POST", `/accounts/${options.accountId}/d1/database/${databaseId}/query`, query);
  const first = Array.isArray(result) ? result[0] : result;
  return first?.results ?? [];
}

async function cf(options, method, path, body) {
  if (options.request) return options.request(method, path, body);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { errors: [{ message: text }] };
    }
  }
  if (!response.ok || data.success === false) {
    const message = (data.errors ?? []).map((error) => error.message).filter(Boolean).join("; ") || response.statusText;
    throw new Error(`${method} ${path} (${response.status}): ${message}`);
  }
  return data.result;
}

async function wrangler(options, args) {
  if (options.wrangler) return options.wrangler(args);
  const child = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: options.token,
      CLOUDFLARE_ACCOUNT_ID: options.accountId,
      WRANGLER_SEND_METRICS: "false",
    },
  });
  return { code: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function buildDashboard() {
  const child = spawnSync("npm", ["run", "build"], { encoding: "utf8" });
  return { code: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function readSecretsMap(path) {
  if (!existsSync(path)) return {};
  const map = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) map[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return map;
}

function rememberSecrets(options, update) {
  const path = options.secretsPath ?? SECRETS_PATH;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const map = new Map();
  for (const line of current.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
  }
  if (update.mailDomain) map.set("MAIL_DOMAIN", update.mailDomain);
  if (update.adminKey) map.set("ADMIN_API_KEY", update.adminKey);
  if (update.dataKey) map.set("DATA_KEY", update.dataKey);
  for (const [id, key] of Object.entries(update.keys ?? {})) map.set(id, key);
  const body = [...map.entries()].map(([key, value]) => `${key}=${value}`).join("\n");
  writeFileSync(path, `${body}\n`);
}

function readState(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseJsonList(text) {
  const start = text.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJson(text) {
  const start = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const cut = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
  if (cut === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(cut));
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

function requireCredentials(options) {
  if (!options.token || !options.accountId) {
    throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  }
}

function printHelp() {
  process.stdout.write(`Usage: npm run setup -- [options]

  --config <file>   Group config. Default bot-mail.config.json
  --dry-run         Print the plan. Makes no Cloudflare calls.
  --status          Print zone, R2, D1, routing, sending, and secret names.
  --teardown        Delete the Worker and disable the catch-all. Requires --yes.
  --include-data    With --teardown, also delete the D1 database and R2 bucket.
  --rotate-secrets  Replace ADMIN_API_KEY and DATA_KEY.
  --rotate-keys     Ignored. Bot API keys are minted on the dashboard or by the admin MCP.
  --share-deploy-token  Store CLOUDFLARE_API_TOKEN as the Worker's CF_API_TOKEN for the Domains
                    page when CLOUDFLARE_DOMAINS_API_TOKEN is not set. A dedicated token is safer.
  --force-catch-all Replace a catch-all that already sends to a different Worker.
  --route <address> With routing "literal", create or update one literal rule. Does not deploy.
  --yes             Confirm teardown.
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  assertSupportedNode();
  loadDotEnv(".env");
  const configFlag = args.indexOf("--config");
  const configPath = configFlag >= 0 ? args[configFlag + 1] : process.env.BOT_MAIL_CONFIG || "bot-mail.config.json";
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy bot-mail.config.example.jsonc and fill it in.`);
  }
  const routeFlag = args.indexOf("--route");
  const routeAddress = routeFlag >= 0 ? args[routeFlag + 1] : "";
  if (routeFlag >= 0 && (!routeAddress || routeAddress.startsWith("--"))) {
    throw new Error("--route needs a local-part or mailbox address");
  }
  const config = loadGroupConfig(configPath);
  const paths = pathsForConfig(configPath);
  const options = {
    config,
    dryRun: args.includes("--dry-run"),
    status: args.includes("--status"),
    teardown: args.includes("--teardown"),
    includeData: args.includes("--include-data"),
    yes: args.includes("--yes"),
    rotateSecrets: args.includes("--rotate-secrets"),
    rotateKeys: args.includes("--rotate-keys"),
    shareDeployToken: args.includes("--share-deploy-token"),
    forceCatchAll: args.includes("--force-catch-all"),
    routeAddress,
    statePath: paths.statePath,
    secretsPath: paths.secretsPath,
    token: process.env.CLOUDFLARE_API_TOKEN || "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    env: process.env,
    lines: [],
    io: { write: (chunk) => process.stdout.write(chunk) },
  };
  if (routeAddress) await runLiteralRoute(options);
  else if (options.status) await runStatus(options);
  else await runSetup(options);
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly || process.argv[1]?.endsWith("setup.mjs")) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "setup failed"}\n`);
    process.exitCode = 1;
  });
}
