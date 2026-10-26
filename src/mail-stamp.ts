import { parseMailbox } from "./address";
import { sha256Hex, verifySecret } from "./crypto";

/** Header added on send and removed from the stored inbound copy. */
export const STAMP_HEADER = "X-BotMail-Stamp";

/** Set only on a bot send's BotMail-recipient copy. */
export const AUTO_SUBMITTED_HEADER = "Auto-Submitted";
export const HOP_HEADER = "X-BotMail-Hops";

export function hopCount(fields: HeaderField[]): number {
  const raw = fields.find((field) => field.name.toLowerCase() === HOP_HEADER.toLowerCase())?.value ?? "";
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return 0;
  return parsed;
}

const MAC_HEX = 32;
const MAX_MACS = 50;
const STAMP_INFO = "botmail-stamp-v1";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_FUTURE_SECONDS = 10 * 60;

const encoder = new TextEncoder();

export type HeaderField = { name: string; value: string };

export function newStampId(from: string): string {
  const domain = parseMailbox(from)?.domain ?? "localhost";
  return `<${crypto.randomUUID()}@${domain}>`;
}

/** HMAC over stamp id, issue time, sender, recipient, and a hash of subject plus body. One mac per BotMail recipient. */
export async function internalStampHeader(
  secret: string,
  stampId: string,
  from: string,
  recipients: string[],
  content: { subject: string; text: string; html: string },
  issuedAt = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (!secret || !issuedAtOk(issuedAt)) return null;
  const fromAddr = parseMailbox(from)?.address;
  const id = stampId.trim();
  if (!fromAddr || !/^<[^<>\s]+>$/.test(id)) return null;
  const targets = [
    ...new Set(recipients.map((item) => parseMailbox(item)?.address).filter((item): item is string => Boolean(item))),
  ];
  if (targets.length === 0 || targets.length > MAX_MACS) return null;
  const key = await deriveStampKey(secret);
  const hash = await contentDigest(content.subject, content.text, content.html);
  const macs: string[] = [];
  for (const recipient of targets) macs.push(await stampMac(key, id, String(issuedAt), fromAddr, recipient, hash));
  const value = `v1 ${id} ${issuedAt} ${macs.join(" ")}`;
  if (encoder.encode(value).byteLength > 2048) return null;
  return value;
}

/** Stamp id when this single header was produced by this Worker for this sender, recipient, and body. */
export async function matchingStampId(
  secret: string,
  headerValue: string | null | undefined,
  from: string,
  to: string,
  content: { subject: string; text: string; html: string },
): Promise<string | null> {
  if (!secret || !headerValue) return null;
  const fromAddr = parseMailbox(from)?.address;
  const toAddr = parseMailbox(to)?.address;
  if (!fromAddr || !toAddr) return null;
  const match = headerValue
    .trim()
    .match(/^v1\s+(<[^<>\s]+>)\s+(\d{1,12})\s+((?:[0-9a-f]{32})(?:\s+[0-9a-f]{32})*)$/i);
  if (!match) return null;
  const stampId = match[1];
  const issuedAt = Number(match[2]);
  if (!issuedAtOk(issuedAt)) return null;
  const macs = match[3].toLowerCase().split(/\s+/);
  if (macs.length === 0 || macs.length > MAX_MACS) return null;
  const key = await deriveStampKey(secret);
  const hash = await contentDigest(content.subject, content.text, content.html);
  const expected = await stampMac(key, stampId, match[2], fromAddr, toAddr, hash);
  let matched = false;
  for (const mac of macs) {
    if (await verifySecret(mac, expected)) matched = true;
  }
  return matched ? stampId : null;
}

export function headerFields(raw: ArrayBuffer): HeaderField[] {
  const block = headerBlock(raw);
  if (!block) return [];
  const fields: HeaderField[] = [];
  let name = "";
  let value = "";
  const push = () => {
    if (name) fields.push({ name, value: value.trim() });
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
  return fields;
}

/** The stamp header when the message has exactly one. More than one is treated as unstamped. */
export function stampHeaderFromRaw(raw: ArrayBuffer): string {
  const values = headerFields(raw)
    .filter((field) => field.name.toLowerCase() === "x-botmail-stamp")
    .map((field) => field.value);
  return values.length === 1 ? values[0] : "";
}

export function stampHeaderCount(raw: ArrayBuffer): number {
  return headerFields(raw).filter((field) => field.name.toLowerCase() === "x-botmail-stamp").length;
}

export function stripStampHeader(raw: ArrayBuffer): ArrayBuffer {
  return stripNamedHeaders(raw, new Set(["x-botmail-stamp"]));
}

/** Verified forwards do not carry the stamp, the hop counter, or Auto-Submitted. */
export function stripForwardHeaders(raw: ArrayBuffer): ArrayBuffer {
  return stripNamedHeaders(raw, new Set(["x-botmail-stamp", "x-botmail-hops", "auto-submitted"]));
}

function stripNamedHeaders(raw: ArrayBuffer, names: Set<string>): ArrayBuffer {
  const bytes = new Uint8Array(raw);
  const end = headerSeparator(bytes);
  if (end < 0) return raw;
  const block = new TextDecoder().decode(bytes.subarray(0, end));
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const kept: string[] = [];
  let skipping = false;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
    skipping = names.has(name);
    if (!skipping) kept.push(line);
  }
  const stripped = kept.join(newline);
  if (stripped === block) return raw;
  const head = encoder.encode(stripped);
  const copy = new ArrayBuffer(head.length + (bytes.length - end));
  const out = new Uint8Array(copy);
  out.set(head, 0);
  out.set(bytes.subarray(end), head.length);
  return copy;
}

export async function contentDigest(subject: string, text: string, html: string): Promise<string> {
  const payload = [normalizePart(subject), normalizePart(text), normalizePart(html)].join("\n");
  return sha256Hex(payload);
}

function normalizePart(value: string): string {
  return value.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function issuedAtOk(issuedAt: number, now = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false;
  if (issuedAt > now + MAX_FUTURE_SECONDS) return false;
  return now - issuedAt <= MAX_AGE_SECONDS;
}

async function deriveStampKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: encoder.encode(STAMP_INFO),
    },
    base,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function stampMac(
  key: CryptoKey,
  stampId: string,
  issuedAt: string,
  from: string,
  recipient: string,
  hash: string,
): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`v1\n${stampId}\n${issuedAt}\n${from}\n${recipient}\n${hash}`));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, MAC_HEX);
}

function headerBlock(raw: ArrayBuffer): string | null {
  const bytes = new Uint8Array(raw);
  const end = headerSeparator(bytes);
  if (end < 0) return null;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function headerSeparator(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, 256 * 1024);
  for (let i = 0; i < limit - 1; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    if (bytes[i] === 10 && bytes[i + 1] === 10) return i;
  }
  return -1;
}
