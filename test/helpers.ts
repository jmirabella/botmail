import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { setAccessCertsFetch } from "../src/auth";
import worker from "../src/index";
import type { InboundEmail } from "../src/inbound";

export const ADMIN_ORIGIN = `https://${env.ADMIN_HOST}`;
export const ACCESS_EMAIL = "ada@example.com";

let accessKeys: Promise<{ privateKey: CryptoKey; jwk: JsonWebKey }> | null = null;

function signingKeys(): Promise<{ privateKey: CryptoKey; jwk: JsonWebKey }> {
  accessKeys ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string };
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    return { privateKey: pair.privateKey, jwk };
  })();
  return accessKeys;
}

export async function useTestAccessKeys(): Promise<void> {
  const { jwk } = await signingKeys();
  setAccessCertsFetch(async () => Response.json({ keys: [jwk] }));
}

export async function accessJwt(extra: Record<string, unknown> = {}): Promise<string> {
  const { privateKey } = await signingKeys();
  await useTestAccessKeys();
  const payload = {
    iss: `https://${env.CF_ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`,
    aud: env.CF_ACCESS_AUD,
    exp: Math.floor(Date.now() / 1000) + 600,
    email: ACCESS_EMAIL,
    ...extra,
  };
  const header = base64UrlText(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const body = base64UrlText(JSON.stringify(payload));
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64UrlBytes(new Uint8Array(signature))}`;
}

/** A request to the admin host carrying a valid Access JWT, unless `jwt` is overridden (null sends none). */
export async function adminRequest(path: string, init: RequestInit = {}, options: { jwt?: string | null } = {}): Promise<Request> {
  const headers = new Headers(init.headers);
  const jwt = options.jwt === undefined ? await accessJwt() : options.jwt;
  if (jwt) headers.set("cf-access-jwt-assertion", jwt);
  return new Request(`${ADMIN_ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

export function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function rawMime(options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
  attachment?: { filename: string; content: string; type: string };
}): string {
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    options.cc ? `Cc: ${options.cc}` : "",
    `Subject: ${options.subject}`,
    "Date: Thu, 09 Oct 2026 12:00:00 +0000",
    `Message-ID: ${options.messageId}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : "",
    options.references ? `References: ${options.references}` : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);
  if (!options.attachment) {
    return [...headers, "Content-Type: text/plain; charset=utf-8", "", options.text, ""].join("\r\n");
  }
  const boundary = "botmailtest";
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text,
    `--${boundary}`,
    `Content-Type: ${options.attachment.type}; name="${options.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    btoa(options.attachment.content),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Headers taken from the MIME block, which is where Worker delivery gets message.headers. */
export function headersFromMime(raw: string): Headers {
  const headers = new Headers();
  const block = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  let name = "";
  let value = "";
  const push = () => {
    if (!name) return;
    try {
      headers.append(name, value.trim());
    } catch {
      // The Headers API rejects a few names. The Worker reads the raw block for auth.
    }
  };
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (name) value += ` ${line.trim()}`;
      continue;
    }
    push();
    const colon = line.indexOf(":");
    if (colon <= 0) {
      name = "";
      value = "";
      continue;
    }
    name = line.slice(0, colon).trim();
    value = line.slice(colon + 1).trim();
  }
  push();
  return headers;
}

export function inboundMessage(raw: string, from: string, to: string, rawSize = raw.length, headers?: Headers): {
  message: InboundEmail;
  rejected: () => string | undefined;
} {
  const bytes = new TextEncoder().encode(raw);
  let reason: string | undefined;
  return {
    message: {
      from,
      to,
      headers: headers ?? headersFromMime(raw),
      raw: new Blob([bytes]).stream(),
      rawSize,
      setReject(next: string) {
        reason = next;
      },
    },
    rejected: () => reason,
  };
}

export async function deliver(raw: string, from: string, to: string, headers?: Headers): Promise<void> {
  const { message } = inboundMessage(raw, from, to, raw.length, headers);
  const ctx = createExecutionContext();
  await worker.email(message, env, ctx);
  await waitOnExecutionContext(ctx);
}

export async function mcpCall(token: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://${env.PUBLIC_HOST}/mcp`, {
      method: "POST",
      headers: {
        host: env.PUBLIC_HOST,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text}`);
  const body = parseMcpPayload(text);
  if (body.error) throw new Error(body.error.message || "MCP error");
  const payload = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(payload || "tool error");
  return payload ? JSON.parse(payload) : body.result;
}

function parseMcpPayload(text: string): {
  result?: { content?: Array<{ text?: string }>; isError?: boolean };
  error?: { message?: string };
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.startsWith("{"));
  const last = data.at(-1);
  if (!last) throw new Error(`Unparsed MCP response: ${trimmed.slice(0, 400)}`);
  return JSON.parse(last) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { message?: string };
  };
}
