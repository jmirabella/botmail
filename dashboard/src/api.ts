export type SendPolicy = "approval" | "direct";

export type Session = {
  email: string;
  send_policy: SendPolicy;
  send_policy_stored: SendPolicy | null;
  send_policy_source: "config" | "dashboard";
  locked_by_env: boolean;
  allowlist: string[];
  allowlist_extra: string[];
  inbound_policy_source: "config" | "dashboard";
  spam_score_threshold: number | null;
  inbound_rate_limit: number;
  inbound_bot_rate_limit: number;
  inbound_auto_reply_limit: number;
  outbound_daily_stamp_limit: number;
  inbound_allowlist: string[];
  inbound_blocklist: string[];
  unknown_policy: UnknownPolicy;
  unknown_bot: string;
  brand_name: string;
  brand_logo: string;
  brand_accent: string;
  mail_domain: string;
  domains: DomainSummary[];
  unique_bot_names: boolean;
  unique_bot_names_source: "config" | "dashboard";
  unique_bot_names_config: boolean;
  cf_api_configured: boolean;
  public_host: string;
  admin_host: string;
  mcp_url: string;
  routing_mode?: "literal" | "catch-all";
};

export type Settings = Omit<Session, "email">;
export type DomainSummary = { domain: string; is_default: boolean; enabled: boolean };
export type CheckState = "ok" | "error" | "pending" | "manual" | "skipped";
export type DomainCheck = { id: string; group: "routing" | "sending" | "dns"; label: string; state: CheckState; detail: string };
export type DomainView = DomainSummary & {
  zone_id: string | null;
  zone_name: string | null;
  bot_count: number;
  mode: "api" | "manual";
  routing: CheckState;
  sending: CheckState;
  dns: CheckState;
  checks: DomainCheck[];
  error: string | null;
  manual_steps: string[];
  dns_commands: string;
  checked_at: string | null;
  deleted_at: string | null;
  archived: boolean;
  created_at: string;
};
export type UnknownPolicy = "unrouted" | "reject" | "default_bot";
export type WebhookStatus = "none" | "ok" | "failing" | "pending";

export type Connector = {
  grant_id: string;
  client_name: string;
  created_at: string;
  last_used_at: string | null;
};

export type Bot = {
  id: string;
  display_name: string;
  address_local: string;
  domain: string;
  address: string;
  notes: string;
  owner_email: string | null;
  enabled: boolean;
  archived: boolean;
  deleted_at: string | null;
  key_configured: boolean;
  webhook_url: string | null;
  webhook_configured: boolean;
  mcp_url: string;
  mcp_transport: string;
  message_count: number;
  unread_count: number;
  last_mail_at: string | null;
  webhook_status: WebhookStatus;
  webhook_last_at: string | null;
  webhook_last_error: string | null;
  forward_to: string | null;
};

export type MailSummary = {
  id: string;
  bot: string;
  direction: "in" | "out";
  folder: string;
  status: string;
  from: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  thread_id: string | null;
  snippet: string | null;
  has_attachments: boolean;
  is_read: boolean;
  plus_tag: string | null;
  auth_result?: string | null;
  auth_passed?: boolean | null;
  quarantine_reason?: string | null;
  spam_score?: number | null;
  via_alias?: string | null;
};

export type MailList = {
  messages: MailSummary[];
  next_cursor: string | null;
};

export type Attachment = {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number;
  disposition: string | null;
  content_id?: string | null;
  inline?: boolean;
};

export type MailDetail = MailSummary & {
  text: string | null;
  html: string;
  body_truncated: boolean;
  raw_size: number | null;
  headers: Record<string, unknown>;
  attachments: Attachment[];
};

export type RouteRule = {
  id: string;
  kind: "alias" | "forward";
  local_part: string;
  domain: string;
  target: string;
  targets?: string[];
  enabled: number;
  deleted_at: string | null;
};

export type Delivery = {
  id: string;
  bot_id: string;
  message_id: string;
  url: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type HealthView = {
  deliveries: Delivery[];
  counts: Array<{ direction: string; status: string; n: number }>;
  dns: { ok: boolean; domain: string; checks: DomainCheck[]; error?: string };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const accessListeners = new Set<() => void>();

export function onAccessLost(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-bot-mail-action"] = "1";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/admin/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401) {
    for (const listener of accessListeners) listener();
    throw new ApiError("Cloudflare Access session expired", 401);
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!response.ok) {
    throw new ApiError(data.error || `Request failed (${response.status})`, response.status, data.code ?? "", data as Record<string, unknown>);
  }
  return data as T;
}
