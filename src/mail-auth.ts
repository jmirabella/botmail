import { getDomain } from "tldts";
import type { HeaderField } from "./mail-stamp";

/** Cloudflare Email Routing stamps this authserv-id on the verdict the Worker can read. */
const CLOUDFLARE_AUTHSERV = "mx.cloudflare.net";
const CLOUDFLARE_ARC_DOMAIN = "cloudflare-email.net";

/** Private suffixes such as github.io count, so a public suffix is not an organizational domain. */
const PSL = { allowPrivateDomains: true, detectIp: false } as const;

export type MailAuth = {
  result: "pass" | "fail" | "unverified";
  passed: boolean | null;
};

const UNVERIFIED: MailAuth = { result: "unverified", passed: null };

type AuthMethod = { method: string; result: string; props: Record<string, string> };
type AuthHeader = { authservId: string; instance: number | null; methods: AuthMethod[] };

/**
 * Verdict from the topmost Cloudflare trace block only.
 * The block starts with Received by cloudflare-email.net and ends at the first
 * X-CF-SpamH-Score, which is included. If that header is missing, the verdict is unverified.
 * Only the first header of each type inside the block is used. Headers under the score are
 * ignored, so a sender-written Authentication-Results or ARC set there stays unverified.
 * A pass still needs dmarc=pass aligned to the From domain and a dkim=pass whose header.d
 * and header.s match a DKIM-Signature. That pass is advisory and does not grant trust:
 * the signature text is something the sender can write. spf=none on smtp.helo does not
 * override dmarc=pass. ARC-Authentication-Results is used only when the block has no
 * Authentication-Results, and only from the first ARC-Seal with d=cloudflare-email.net.
 */
export function cloudflareMailAuth(fields: HeaderField[], fromDomain: string): MailAuth {
  const block = cloudflareTraceBlock(fields);
  if (!block) return UNVERIFIED;
  const methods = methodsFromBlock(block);
  if (!methods) return UNVERIFIED;
  const from = asciiDomain(fromDomain);
  const dmarc = methods.find((method) => method.method === "dmarc");
  const signatures = dkimSignatures(fields);
  const alignedDkim = methods.some((method) => alignedDkimPass(method, from, signatures));
  if (dmarc?.result === "pass" && aligns(domainOf(dmarc.props["header.from"]), from) && alignedDkim) {
    return { result: "pass", passed: true };
  }
  if (dmarc?.result === "fail" && alignedDkim) return { result: "fail", passed: false };
  return UNVERIFIED;
}

/**
 * Header 0 is Cloudflare's Received. The block ends at the first X-CF-SpamH-Score, inclusive.
 * A missing score header means this is not a usable Cloudflare block.
 */
export function cloudflareTraceBlock(fields: HeaderField[]): HeaderField[] | null {
  const first = fields[0];
  if (!first || first.name.toLowerCase() !== "received" || !/\bby\s+cloudflare-email\.net\b/i.test(first.value)) return null;
  const block = [first];
  for (const field of fields.slice(1)) {
    if (!traceHeader(field.name)) return null;
    block.push(field);
    if (field.name.toLowerCase() === "x-cf-spamh-score") return block;
  }
  return null;
}

function traceHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "received" ||
    lower === "received-spf" ||
    lower === "authentication-results" ||
    lower.startsWith("arc-") ||
    lower.startsWith("x-cf-")
  );
}

function firstHeader(block: HeaderField[], name: string): HeaderField | undefined {
  return block.find((field) => field.name.toLowerCase() === name);
}

function methodsFromBlock(block: HeaderField[]): AuthMethod[] | null {
  const direct = firstHeader(block, "authentication-results");
  if (direct) {
    const parsed = splitAuthHeader(direct.value);
    if (parsed?.authservId !== CLOUDFLARE_AUTHSERV) return null;
    return parsed.methods;
  }
  return arcMethods(block);
}

function arcMethods(block: HeaderField[]): AuthMethod[] | null {
  const seal = parseSeal(firstHeader(block, "arc-seal")?.value ?? "");
  if (!seal || seal.domain !== CLOUDFLARE_ARC_DOMAIN) return null;
  const parsed = splitAuthHeader(firstHeader(block, "arc-authentication-results")?.value ?? "");
  if (parsed?.instance !== seal.instance || parsed.authservId !== CLOUDFLARE_AUTHSERV) return null;
  return parsed.methods;
}

function parseSeal(value: string): { instance: number; domain: string } | null {
  const parts = splitSemicolons(value);
  if (!parts) return null;
  let instance: number | null = null;
  let domain = "";
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim().replace(/\s+/g, "").toLowerCase();
    if (key === "i" && /^\d+$/.test(raw)) instance = Number(raw);
    if (key === "d") domain = asciiDomain(raw);
  }
  if (instance == null || !domain) return null;
  return { instance, domain };
}

function splitAuthHeader(value: string): AuthHeader | null {
  const parts = splitSemicolons(value);
  if (!parts || parts.length === 0) return null;
  let index = 0;
  let instance: number | null = null;
  const leading = firstToken(parts[0] ?? "");
  if (/^i=\d+$/i.test(leading)) {
    instance = Number(leading.slice(2));
    index = 1;
  }
  const authservId = unquoteToken(firstToken(parts[index] ?? "")).toLowerCase();
  if (!authservId) return null;
  const methods: AuthMethod[] = [];
  for (const part of parts.slice(index + 1)) {
    const method = parseMethod(part);
    if (method) methods.push(method);
  }
  return { authservId, instance, methods };
}

function parseMethod(segment: string): AuthMethod | null {
  const tokens = scanTokens(segment);
  const head = tokens[0]?.match(/^([A-Za-z][A-Za-z0-9]*)=([A-Za-z0-9]+)$/);
  if (!head?.[1] || !head[2]) return null;
  const props: Record<string, string> = {};
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq).toLowerCase();
    const value = token.slice(eq + 1).replace(/^"|"$/g, "").toLowerCase();
    if (key && value) props[key] = value;
  }
  return { method: head[1].toLowerCase(), result: head[2].toLowerCase(), props };
}

function alignedDkimPass(method: AuthMethod, fromDomain: string, signatures: Array<{ d: string; s: string }>): boolean {
  if (method.method !== "dkim" || method.result !== "pass") return false;
  const domain = asciiDomain(domainOf(method.props["header.d"]));
  const selector = (method.props["header.s"] ?? "").toLowerCase();
  if (!selector || !aligns(domain, fromDomain)) return false;
  return signatures.some((signature) => signature.d === domain && signature.s === selector);
}

function dkimSignatures(fields: HeaderField[]): Array<{ d: string; s: string }> {
  const signatures: Array<{ d: string; s: string }> = [];
  for (const field of fields) {
    if (field.name.toLowerCase() !== "dkim-signature") continue;
    const parts = splitSemicolons(field.value);
    if (!parts) continue;
    let domain = "";
    let selector = "";
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const tag = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim().replace(/\s+/g, "").toLowerCase();
      if (tag === "d") domain = asciiDomain(value);
      if (tag === "s") selector = value;
    }
    if (domain && selector) signatures.push({ d: domain, s: selector });
  }
  return signatures;
}

/**
 * Relaxed alignment inside one organizational domain.
 * The From domain and the authenticated domain must be equal or one under the other,
 * and neither side may be a public suffix.
 */
function aligns(authenticated: string, fromDomain: string): boolean {
  const auth = asciiDomain(authenticated);
  const from = asciiDomain(fromDomain);
  if (!auth || !from) return false;
  if (from !== auth && !from.endsWith(`.${auth}`) && !auth.endsWith(`.${from}`)) return false;
  const authOrg = getDomain(auth, PSL)?.toLowerCase() ?? "";
  const fromOrg = getDomain(from, PSL)?.toLowerCase() ?? "";
  return authOrg !== "" && authOrg === fromOrg;
}

function domainOf(value: string | undefined): string {
  const text = String(value ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  const at = text.lastIndexOf("@");
  return at >= 0 ? text.slice(at + 1) : text;
}

/** U-label and A-label compare as the same ASCII hostname. */
function asciiDomain(value: string): string {
  const text = domainOf(value).replace(/\.$/, "");
  if (!text || /[\s/\\?#@<>]/.test(text)) return "";
  try {
    const host = new URL(`http://${text}`).hostname.replace(/\.$/, "");
    return host && !host.includes("%") ? host : "";
  } catch {
    return "";
  }
}

/**
 * Split on semicolons that are outside comments and quoted strings. Comments are removed.
 * A `)` inside a local part copied into a comment ends that comment early. A comment that
 * contains `"` or `;` is rejected, as is a `)` outside any comment, so the broken-out text
 * cannot inject a method.
 */
function splitSemicolons(value: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let comment = 0;
  let quote = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i] ?? "";
    if (quote) {
      current += char;
      if (char === "\\") {
        const next = value[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (comment > 0) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === '"' || char === ";") return null;
      if (char === "(") comment += 1;
      else if (char === ")") {
        comment -= 1;
        if (comment === 0) {
          let next = i + 1;
          while (next < value.length && /\s/.test(value[next] ?? "")) next += 1;
          if ((value[next] ?? "") === ";") return null;
        }
      }
      continue;
    }
    if (char === '"') {
      quote = true;
      current += char;
      continue;
    }
    if (char === "(") {
      comment = 1;
      continue;
    }
    if (char === ")") return null;
    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }
  if (comment !== 0 || quote) return null;
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function scanTokens(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] ?? "")) i += 1;
    if (i >= input.length) break;
    if (input[i] === '"') {
      let token = "";
      i += 1;
      while (i < input.length) {
        const char = input[i] ?? "";
        if (char === "\\") {
          const next = input[i + 1];
          if (next !== undefined) token += next;
          i += 2;
          continue;
        }
        if (char === '"') {
          i += 1;
          break;
        }
        token += char;
        i += 1;
      }
      while (i < input.length && !/\s/.test(input[i] ?? "")) {
        token += input[i] ?? "";
        i += 1;
      }
      if (token) tokens.push(token);
      continue;
    }
    let token = "";
    while (i < input.length && !/\s/.test(input[i] ?? "")) {
      token += input[i] ?? "";
      i += 1;
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

function firstToken(input: string): string {
  return scanTokens(input)[0] ?? "";
}

function unquoteToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) return token.slice(1, -1);
  return token;
}
