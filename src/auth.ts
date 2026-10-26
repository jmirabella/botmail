import { sha256Hex, verifySecret } from "./crypto";
import { coerceOwnerEmail, getBotByKeyHash, type BotRow } from "./db";
import { logError } from "./log";

export type Session =
  | { kind: "admin" }
  | { kind: "bot"; bot: BotRow };

type AccessJwk = { kid?: string; kty: string; n?: string; e?: string; alg?: string };
type JwksCache = { team: string; expires: number; keys: AccessJwk[] };

let jwksCache: JwksCache | null = null;
let certsFetch: typeof fetch | null = null;

export function setAccessCertsFetch(next: typeof fetch | null): void {
  certsFetch = next;
  jwksCache = null;
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

export type AccessIdentity = { email: string };

export async function authenticate(request: Request, env: Env): Promise<Session | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (await verifySecret(token, env.ADMIN_API_KEY)) return { kind: "admin" };
  const bot = await getBotByKeyHash(env, await sha256Hex(token));
  return bot ? { kind: "bot", bot } : null;
}

export function accessConfigured(env: Env): boolean {
  return Boolean(accessTeam(env) && accessAud(env));
}

/**
 * Email from a Cf-Access-Jwt-Assertion that verifies against the team certs and audience.
 * A bare user-email header is ignored. Failure returns null so mailbox creation can continue unowned.
 */
export async function verifiedOwnerEmail(request: Request, env: Env): Promise<string | null> {
  try {
    const identity = await accessIdentity(request, env);
    return coerceOwnerEmail(identity?.email);
  } catch (error) {
    logError("access_owner_failed", { error: error instanceof Error ? error.message : "verify failed" });
    return null;
  }
}

export async function accessIdentity(request: Request, env: Env): Promise<AccessIdentity | null> {
  const team = accessTeam(env);
  const aud = accessAud(env);
  const jwt = request.headers.get("cf-access-jwt-assertion")?.trim() ?? "";
  if (!jwt || !team || !aud) return null;
  try {
    return await verifyAccessJwt(jwt, team, aud, accessEmailDomains(env));
  } catch (error) {
    logError("access_jwt_failed", { error: error instanceof Error ? error.message : "verify failed" });
    return null;
  }
}

function accessTeam(env: Env): string {
  return String(env.CF_ACCESS_TEAM_DOMAIN || "").trim().toLowerCase();
}

function accessAud(env: Env): string {
  return String(env.CF_ACCESS_AUD || "").trim();
}

function accessEmailDomains(env: Env): string[] {
  return String(env.ACCESS_EMAIL_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

async function verifyAccessJwt(jwt: string, team: string, aud: string, emailDomains: string[]): Promise<AccessIdentity | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;
  const header = JSON.parse(new TextDecoder().decode(base64Url(headerPart))) as { alg?: string; kid?: string };
  const payload = JSON.parse(new TextDecoder().decode(base64Url(payloadPart))) as {
    aud?: string | string[];
    exp?: number;
    iss?: string;
    email?: string;
  };
  if (header.alg !== "RS256") return null;
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(aud)) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  if (!emailDomainAllowed(payload.email, emailDomains)) return null;
  const key = await accessKey(team, header.kid);
  if (!key) return null;
  const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, base64Url(signaturePart), data);
  return valid ? { email: String(payload.email ?? "").trim().toLowerCase() } : null;
}

function emailDomainAllowed(email: string | undefined, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const value = String(email ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at < 1) return false;
  return domains.includes(value.slice(at + 1));
}

function base64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function accessKey(team: string, kid: string | undefined): Promise<CryptoKey | null> {
  const now = Date.now();
  if (!jwksCache || jwksCache.team !== team || jwksCache.expires < now) {
    const response = await (certsFetch ?? fetch)(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: AccessJwk[] };
    jwksCache = { team, expires: now + 10 * 60 * 1000, keys: body.keys ?? [] };
  }
  const jwk = jwksCache.keys.find((key) => key.kty === "RSA" && (!kid || key.kid === kid));
  if (!jwk?.n || !jwk.e) return null;
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}
