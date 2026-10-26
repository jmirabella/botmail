import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_AUTHOR_NAME = "Joshua Mirabella";
export const DEFAULT_AUTHOR_EMAIL = "29336554+jmirabella@users.noreply.github.com";
export const COMMIT_MESSAGE_PATH = "(commit message)";

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^[/A-Za-z0-9._-]+$/;
const WORKFLOW_PATH = ".github/workflows/public-sync.yml";

export function parseDenylist(raw) {
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!text.trim() || entries.length === 0) throw new Error("PUBLIC_SYNC_DENYLIST is empty");
  return entries;
}

export function parseExcludeList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function isExcluded(relPath, patterns) {
  const file = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((pattern) => {
    const prefix = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!prefix || prefix === "." || prefix.split("/").includes("..")) return false;
    return file === prefix || file.startsWith(`${prefix}/`);
  });
}

export function leakLines(text, needles) {
  const lowered = needles.map((needle) => needle.toLowerCase()).filter(Boolean);
  if (lowered.length === 0) return [];
  const lines = String(text).split(/\r?\n/);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    const haystack = lines[index].toLowerCase();
    if (lowered.some((needle) => haystack.includes(needle))) hits.push(index + 1);
  }
  return hits;
}

export function scanBuffer(buffer, needles) {
  const texts = [buffer.toString("utf8")];
  if (buffer.length >= 2) texts.push(buffer.toString("utf16le"));
  const lines = new Set();
  for (const text of texts) {
    for (const line of leakLines(text, needles)) lines.add(line);
  }
  return [...lines].sort((left, right) => left - right);
}

export function scanSnapshot(root, needles) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const stat = lstatSync(file);
    const text = stat.isSymbolicLink() ? readlinkSync(file) : null;
    const lines = text === null ? scanBuffer(readFileSync(file), needles) : leakLines(text, needles);
    for (const line of lines) hits.push({ path: rel, line });
  }
  return hits;
}

export function scanCommitMessage(message, needles) {
  return leakLines(message, needles).map((line) => ({ path: COMMIT_MESSAGE_PATH, line }));
}

export function formatLeak(hit) {
  return `leak: ${hit.path}:${hit.line}`;
}

export function syncAuthor(env = process.env) {
  const name = String(env.PUBLIC_SYNC_AUTHOR_NAME ?? "").trim() || DEFAULT_AUTHOR_NAME;
  const email = String(env.PUBLIC_SYNC_AUTHOR_EMAIL ?? "").trim() || DEFAULT_AUTHOR_EMAIL;
  if (/[\r\n<>]/.test(name) || /[\r\n<>\s]/.test(email)) throw new Error("public sync author is not usable");
  return { name, email };
}

export function replaceHistoryRequested(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "push") return false;
  const flag = String(env.PUBLIC_SYNC_REPLACE_HISTORY ?? "").trim().toLowerCase();
  return flag === "true" || flag === "1";
}

export function gitPushArgs(replace) {
  return replace ? ["push", "--force", "origin", "HEAD:main"] : ["push", "origin", "HEAD:main"];
}

export function exportSnapshot({ repo, sha = "HEAD", dest, patterns }) {
  assertSha(sha);
  mkdirSync(dest, { recursive: true });
  const tarPath = path.join(tmpdir(), `.public-sync-export-${process.pid}-${Date.now()}.tar`);
  const archived = spawnSync("git", ["archive", "--format=tar", "-o", tarPath, sha], { cwd: repo });
  if (archived.status !== 0) {
    throw new Error(archived.stderr.toString("utf8").trim() || "git archive failed");
  }
  const extracted = spawnSync("tar", ["-xf", tarPath, "-C", dest]);
  rmSync(tarPath, { force: true });
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr.toString("utf8").trim() || "tar extract failed");
  }
  for (const file of walkFiles(dest)) {
    const rel = path.relative(dest, file).split(path.sep).join("/");
    if (isExcluded(rel, patterns)) rmSync(file, { force: true });
  }
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    const stat = lstatSync(full);
    if (stat.isDirectory()) files.push(...walkFiles(full));
    else if (stat.isFile() || stat.isSymbolicLink()) files.push(full);
  }
  return files;
}

function assertSha(sha) {
  if (sha !== "HEAD" && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("refusing unsafe commit id");
}

function gitHost() {
  const server = process.env.GITHUB_SERVER_URL || process.env.PUBLIC_GIT_SERVER_URL || "";
  if (!server) throw new Error("GITHUB_SERVER_URL is not set");
  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error("GITHUB_SERVER_URL is not a URL");
  }
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error("GITHUB_SERVER_URL is not a usable git host");
  return parsed.hostname;
}

function publicRepo() {
  const repo = (process.env.PUBLIC_REPO || "").trim();
  if (!REPO_NAME.test(repo)) throw new Error("PUBLIC_REPO must be owner/name");
  const [owner, name] = repo.split("/");
  if (owner.startsWith(".") || name.startsWith(".")) throw new Error("PUBLIC_REPO must be owner/name");
  return { owner, name };
}

function redact(text) {
  let out = String(text ?? "");
  const secrets = [process.env.PUBLIC_REPO_DEPLOY_KEY, process.env.PUBLIC_SYNC_DENYLIST];
  for (const secret of secrets) {
    if (!secret) continue;
    if (secret.trim()) out = out.split(secret).join("[redacted]");
    for (const line of secret.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length >= 4) out = out.split(trimmed).join("[redacted]");
    }
  }
  return out;
}

function runGit(args, { cwd, env } = {}) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw new Error(redact(result.error.message));
  if (result.status !== 0) throw new Error(redact((result.stderr || result.stdout || "").trim()) || `git ${args[0]} failed`);
  return result.stdout;
}

function identityEnv(author, extra = {}) {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

function prepareSsh(directory, host) {
  const keyRaw = process.env.PUBLIC_REPO_DEPLOY_KEY ?? "";
  if (!keyRaw.trim()) throw new Error("PUBLIC_REPO_DEPLOY_KEY is empty");
  let key = keyRaw.replace(/\r\n/g, "\n");
  if (!key.endsWith("\n")) key += "\n";
  if (!key.includes("PRIVATE KEY")) throw new Error("PUBLIC_REPO_DEPLOY_KEY is not a private key");
  const keyPath = path.join(directory, "deploy_key");
  const knownHosts = path.join(directory, "known_hosts");
  if (!SAFE_PATH.test(keyPath) || !SAFE_PATH.test(knownHosts)) throw new Error("refusing unsafe ssh path");
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const scanned = spawnSync("ssh-keyscan", ["-T", "10", host], { encoding: "utf8" });
  if (scanned.status !== 0 || !scanned.stdout.includes(host)) throw new Error("could not collect the git host key");
  writeFileSync(knownHosts, scanned.stdout, { mode: 0o644 });
  const command = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`;
  return identityEnv(syncAuthor(), { GIT_SSH_COMMAND: command });
}

export function applySnapshot({ checkout, sourceDir, message, replace, author, env }) {
  const identity = author || syncAuthor();
  const gitEnv = env || identityEnv(identity);
  runGit(["config", "commit.gpgsign", "false"], { cwd: checkout, env: gitEnv });
  if (replace) {
    console.log("replacing public history with one root commit");
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: checkout, encoding: "utf8" });
    if (head.status === 0) runGit(["checkout", "--orphan", "public-sync-root"], { cwd: checkout, env: gitEnv });
  }
  replaceTree(sourceDir, checkout);
  runGit(["add", "-A"], { cwd: checkout, env: gitEnv });
  if (!replace && !runGit(["status", "--porcelain"], { cwd: checkout, env: gitEnv }).trim()) {
    console.log("public snapshot already matches");
    return false;
  }
  const messagePath = path.join(tmpdir(), `public-sync-msg-${process.pid}-${Date.now()}.txt`);
  writeFileSync(messagePath, message.endsWith("\n") ? message : `${message}\n`);
  try {
    runGit(
      ["commit", "--no-gpg-sign", "--cleanup=verbatim", `--author=${identity.name} <${identity.email}>`, "-F", messagePath],
      { cwd: checkout, env: gitEnv },
    );
  } finally {
    rmSync(messagePath, { force: true });
  }
  return true;
}

function replaceTree(fromDir, toDir) {
  for (const entry of readdirSync(toDir)) {
    if (entry === ".git") continue;
    rmSync(path.join(toDir, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(fromDir)) {
    if (entry === ".git") continue;
    cpSync(path.join(fromDir, entry), path.join(toDir, entry), { recursive: true });
  }
}

export function publish(options = {}) {
  const repo = options.repo || process.cwd();
  const sha = options.sha || process.env.SOURCE_SHA || "HEAD";
  assertSha(sha);
  const needles = parseDenylist(process.env.PUBLIC_SYNC_DENYLIST);
  const excludeFile = path.join(repo, ".public-sync-exclude");
  if (!existsSync(excludeFile)) throw new Error("missing .public-sync-exclude");
  const patterns = parseExcludeList(readFileSync(excludeFile, "utf8"));
  if (!isExcluded(WORKFLOW_PATH, patterns)) throw new Error(".public-sync-exclude must omit the sync workflow");

  const work = mkdtempSync(path.join(tmpdir(), "public-sync-"));
  try {
    const exported = path.join(work, "export");
    exportSnapshot({ repo, sha, dest: exported, patterns });
    const message = runGit(["-c", "i18n.logOutputEncoding=utf-8", "log", "-1", "--format=%B", sha], { cwd: repo });
    const hits = [...scanSnapshot(exported, needles), ...scanCommitMessage(message, needles)];
    if (hits.length > 0) {
      for (const hit of hits) console.error(formatLeak(hit));
      throw new Error("leak scan failed");
    }
    if (!message.trim()) throw new Error("triggering commit message is empty");

    const replace = replaceHistoryRequested();
    const author = syncAuthor();
    const target = publicRepo();
    const host = gitHost();
    const url = `git@${host}:${target.owner}/${target.name}.git`;
    const env = prepareSsh(work, host);
    const checkout = path.join(work, "public");
    const heads = runGit(["ls-remote", "--heads", url], { cwd: work, env });
    const hasMain = heads.split(/\r?\n/).some((line) => line.endsWith("refs/heads/main"));
    if (!heads.trim()) {
      mkdirSync(checkout);
      runGit(["init", "-b", "main"], { cwd: checkout, env });
      runGit(["remote", "add", "origin", url], { cwd: checkout, env });
    } else if (!hasMain) {
      throw new Error("public repo has commits but no main branch");
    } else {
      runGit(["clone", "--depth", "1", "--branch", "main", url, checkout], { cwd: work, env });
    }

    const hooks = path.join(work, "no-hooks");
    mkdirSync(hooks);
    runGit(["config", "core.hooksPath", hooks], { cwd: checkout, env });
    runGit(["config", "core.autocrlf", "false"], { cwd: checkout, env });
    const committed = applySnapshot({ checkout, sourceDir: exported, message, replace, author, env });
    if (!committed) return;
    runGit(gitPushArgs(replace), { cwd: checkout, env });
    console.log(replace ? "replaced public main with one root commit" : "published snapshot");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  const command = process.argv[2];
  if (command !== "publish") {
    console.error("Usage: node scripts/public-sync.mjs publish");
    process.exit(1);
  }
  try {
    publish();
  } catch (error) {
    const message = error instanceof Error ? error.message : "public sync failed";
    if (message !== "leak scan failed") console.error(redact(message));
    process.exit(1);
  }
}
