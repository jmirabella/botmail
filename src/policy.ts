import { domainOf, parseMailbox } from "./address";

export type SendPolicy = "direct" | "approval";

/** Map config, the SEND_POLICY var, and older stored values onto the two modes. */
export function normalizeSendPolicy(value: string | null | undefined): SendPolicy | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "direct" || text === "open") return "direct";
  if (text === "approval" || text === "strict") return "approval";
  return null;
}

export type PolicyDecision = {
  policy: SendPolicy;
  allowed: boolean;
  external: string[];
};

export function normalizeAllowlist(entries: string[]): string[] {
  const out = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed.includes("@")) {
      const mailbox = parseMailbox(trimmed);
      if (mailbox) out.add(mailbox.address);
      continue;
    }
    const domain = trimmed.replace(/^@/, "");
    if (domain.includes(".")) out.add(domain);
  }
  return [...out];
}

export function parseAllowlistText(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return normalizeAllowlist(parsed.map((item) => String(item)));
    } catch {
      return [];
    }
  }
  return normalizeAllowlist(trimmed.split(","));
}

/** `mailDomain` is every enabled BotMail domain; mail between them never needs approval. */
export function decideSend(input: {
  recipients: string[];
  mailDomain: string | string[];
  allowlist: string[];
  policy: SendPolicy;
  /** When set, `direct` does not bypass the allowlist. Callers reject instead of holding. */
  allowlistOnly?: boolean;
}): PolicyDecision {
  if (!input.allowlistOnly && normalizeSendPolicy(input.policy) === "direct") {
    return { policy: "direct", allowed: true, external: [] };
  }
  const internal = new Set((Array.isArray(input.mailDomain) ? input.mailDomain : [input.mailDomain]).map((item) => item.trim().toLowerCase()));
  const allow = new Set(normalizeAllowlist(input.allowlist));
  const external: string[] = [];
  for (const recipient of input.recipients) {
    const mailbox = parseMailbox(recipient);
    if (!mailbox) {
      external.push(recipient);
      continue;
    }
    if (internal.has(mailbox.domain)) continue;
    if (allow.has(mailbox.address) || allow.has(mailbox.domain)) continue;
    external.push(mailbox.address);
  }
  return { policy: "approval", allowed: external.length === 0, external };
}

export function recipientAllowed(address: string, mailDomain: string | string[], allowlist: string[]): boolean {
  return decideSend({
    recipients: [address],
    mailDomain,
    allowlist,
    policy: "approval",
  }).allowed;
}

export function sameDomain(address: string, mailDomain: string): boolean {
  return domainOf(address) === mailDomain.trim().toLowerCase();
}
