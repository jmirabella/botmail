const BODY_CAP = 400_000;

export function capBody(value: string | undefined): { text: string | null; truncated: boolean } {
  if (!value) return { text: null, truncated: false };
  if (value.length <= BODY_CAP) return { text: value, truncated: false };
  return { text: value.slice(0, BODY_CAP), truncated: true };
}

export function snippetFrom(text: string | null | undefined, html: string | null | undefined): string {
  const source = (text && text.trim()) || stripHtml(html || "");
  return source.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

export function sanitizeHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeKeyPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._=-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "part").slice(0, 120);
}

export function utcParts(iso: string): { yyyy: string; mm: string; dd: string } {
  const date = new Date(iso);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const yyyy = String(valid.getUTCFullYear());
  const mm = String(valid.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(valid.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd };
}
