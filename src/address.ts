export type Mailbox = {
  local: string;
  plus: string | null;
  domain: string;
  address: string;
};

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Cross-script letters that still look like ASCII after NFKD. Fullwidth folds without this map. */
const CONFUSABLES: Record<string, string> = {
  "\u0131": "i",
  "\u0261": "g",
  "\u03b9": "i",
  "\u03bd": "v",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03c7": "x",
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0455": "s",
  "\u0456": "i",
  "\u0458": "j",
  "\u04bb": "h",
  "\u04cf": "l",
  "\u0501": "d",
  "\u051b": "q",
  "\u051d": "w",
  "\u0251": "a",
  "\u0585": "o",
  "\u1d0f": "o",
};

export function parseMailbox(input: string): Mailbox | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const angle = trimmed.match(/<([^<>\s]+)>/);
  const raw = (angle?.[1] ?? trimmed).trim().normalize("NFKC").toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return null;
  const localFull = raw.slice(0, at);
  const domain = raw.slice(at + 1).replace(/\.$/, "");
  if (!domain || /[\s,]/.test(localFull) || localFull.includes("@") || /[%\\"]/.test(localFull)) return null;
  if (!domainOk(domain)) return null;
  const plusAt = localFull.indexOf("+");
  const local = (plusAt === -1 ? localFull : localFull.slice(0, plusAt)).trim();
  const plusRaw = plusAt === -1 ? "" : localFull.slice(plusAt + 1).trim();
  if (!local) return null;
  return {
    local,
    plus: plusRaw || null,
    domain,
    address: `${local}@${domain}`,
  };
}

/** NFKC, punycode decoded to Unicode, confusable letters folded, then IDNA ASCII. */
export function domainSkeleton(domain: string): string {
  const trimmed = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return "";
  let unicode = trimmed;
  try {
    unicode = domainToUnicode(trimmed) || trimmed;
  } catch {
    return "";
  }
  const stripped = unicode.normalize("NFKD").replace(/\p{M}/gu, "");
  let mapped = "";
  for (const char of stripped) mapped += CONFUSABLES[char] ?? char;
  mapped = mapped.replaceAll("0", "o").replaceAll("1", "l").replaceAll("rn", "m");
  try {
    return (domainToASCII(mapped) || "").toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Exact domain, a subdomain, or a confusable skeleton of one. */
export function domainMatches(domain: string, claimedDomains: string[]): boolean {
  const name = domainSkeleton(domain);
  if (!name) return false;
  return claimedDomains.some((claimed) => {
    const target = domainSkeleton(claimed);
    return target !== "" && (name === target || name.endsWith(`.${target}`));
  });
}

/** True when raw address text contains a hostname whose skeleton is one of `domains`. */
export function textClaimsBotDomain(text: string, domains: string[]): boolean {
  if (!text || domains.length === 0) return false;
  const tokens = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}.-]+/gu) ?? [];
  return tokens.some((token) => token.includes(".") && domainMatches(token, domains));
}

export function claimsOwnerDomain(address: string, domains: string[]): boolean {
  const domain = parseMailbox(address)?.domain;
  if (!domain || domains.length === 0) return false;
  return domainMatches(domain, domains);
}

function domainOk(domain: string): boolean {
  return HOSTNAME.test(domainToASCII(domain));
}

function domainToASCII(domain: string): string {
  if (!domain || /[\s/\\?#@<>]/.test(domain)) return "";
  try {
    const host = new URL(`http://${domain}`).hostname;
    return host && !host.includes("%") ? host : "";
  } catch {
    return "";
  }
}

function domainToUnicode(domain: string): string {
  return domain
    .split(".")
    .map((label) => (label.toLowerCase().startsWith("xn--") ? punyDecode(label.slice(4)) || label : label))
    .join(".");
}

function punyDecode(input: string): string {
  const output: number[] = [];
  let n = 128;
  let i = 0;
  let bias = 72;
  const basic = input.lastIndexOf("-");
  const start = basic < 0 ? 0 : basic;
  for (let index = 0; index < start; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 128) return "";
    output.push(code);
  }
  let index = start > 0 ? start + 1 : 0;
  while (index < input.length) {
    const oldi = i;
    let weight = 1;
    for (let k = 36; ; k += 36) {
      if (index >= input.length) return "";
      const digit = punyDigit(input.charCodeAt(index));
      index += 1;
      if (digit >= 36) return "";
      i += digit * weight;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      weight *= 36 - t;
    }
    const length = output.length + 1;
    bias = punyAdapt(i - oldi, length, oldi === 0);
    n += Math.floor(i / length);
    i %= length;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

function punyDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 22;
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97;
  return 36;
}

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let next = firstTime ? Math.floor(delta / 700) : delta >> 1;
  next += Math.floor(next / numPoints);
  let k = 0;
  while (next > 455) {
    next = Math.floor(next / 35);
    k += 36;
  }
  return k + Math.floor((36 * next) / (next + 38));
}

export function domainOf(address: string): string | null {
  return parseMailbox(address)?.domain ?? null;
}

export function ensureAngle(messageId: string): string {
  const trimmed = messageId.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replaceAll(/[<>]/g, "")}>`;
}

export function messageIdTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/<[^<>\s]+>/g);
  if (matches && matches.length > 0) return [...new Set(matches)];
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(ensureAngle);
}

export function fitHeaderValue(ids: string[], maxBytes = 2048): string {
  const normalized = ids.map(ensureAngle).filter(Boolean);
  while (normalized.length > 1 && encoderLength(normalized.join(" ")) > maxBytes) {
    normalized.shift();
  }
  const joined = normalized.join(" ");
  if (encoderLength(joined) <= maxBytes) return joined;
  return joined.slice(0, maxBytes);
}

function encoderLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function mailDomain(env: Env): string {
  const domain = env.MAIL_DOMAIN.trim().toLowerCase();
  if (!domain || !domain.includes(".") || domain.includes("@") || domain.includes("/")) {
    throw new Error("MAIL_DOMAIN is not configured");
  }
  return domain;
}

export function botAddress(local: string, domain: string): string {
  return `${local}@${domain}`;
}

/** A bot's own address. Rows from before migration 0004 have domain '' until ensureDomains runs. */
export function botMailbox(env: Env, bot: { address_local: string; domain: string }): string {
  return botAddress(bot.address_local, bot.domain || mailDomain(env));
}
