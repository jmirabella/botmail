const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shortTime(value: string | null | undefined, now = Date.now()): string {
  const date = parse(value);
  if (!date) return "";
  const diff = now - date.getTime();
  if (diff < MINUTE) return "now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY && new Date(now).getDate() === date.getDate()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (diff < 2 * DAY) return "Yesterday";
  if (diff < 6 * DAY) return date.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  const date = parse(value);
  if (!date) return "Never";
  const diff = now - date.getTime();
  const ahead = diff < 0;
  const abs = Math.abs(diff);
  let text: string;
  if (abs < MINUTE) return "just now";
  if (abs < HOUR) text = `${Math.floor(abs / MINUTE)} min`;
  else if (abs < DAY) text = `${Math.floor(abs / HOUR)} hr`;
  else if (abs < 30 * DAY) {
    const days = Math.floor(abs / DAY);
    text = `${days} day${days === 1 ? "" : "s"}`;
  } else return fullTime(value);
  return ahead ? `in ${text}` : `${text} ago`;
}

export function fullTime(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return "";
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function bytes(size: number | null | undefined): string {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function parseAddress(value: string | null | undefined): { name: string; email: string } {
  const text = String(value ?? "").trim();
  const match = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() || match[2] || "", email: match[2]?.trim() || "" };
  return { name: text, email: text };
}

export function initials(value: string): string {
  const clean = value.replace(/@.*/, "").replace(/[^a-zA-Z0-9 ._-]/g, " ").trim();
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (clean.slice(0, 2) || "?").toUpperCase();
}

export function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash % 360;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const GENERIC_LABELS = new Set(["bot", "bots", "mail", "email", "mx", "agent", "agents", "inbox"]);

/** The label that tells two domains apart, matching the Worker's id suggestion: bot.desk.email gives "desk". */
export function domainTag(domain: string): string {
  const labels = domain.split(".").slice(0, -1);
  return labels.find((label) => !GENERIC_LABELS.has(label)) ?? labels[0] ?? domain;
}
