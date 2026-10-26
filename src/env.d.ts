// Optional secret: `wrangler types` only sees required secrets. Without it the Domains page shows manual steps.
// OAUTH_KV is declared in generated wrangler config. OAUTH_PROVIDER is injected per request by workers-oauth-provider.
interface Env {
  CF_API_TOKEN?: string;
  /** Stamped mail between one sender and one mailbox each hour. Absent means 30. */
  INBOUND_BOT_RATE_LIMIT?: string;
  /** Bot sends one mailbox may make to one BotMail recipient in the window. Absent means 20. */
  INBOUND_AUTO_REPLY_LIMIT?: string;
  /** Seconds in the auto-reply window. Absent means 3600. */
  INBOUND_AUTO_REPLY_WINDOW?: string;
  /** Stamped BotMail recipients one bot may send in a day. Absent means 200. */
  OUTBOUND_DAILY_STAMP_LIMIT?: string;
  // Set only for a literal-routing install. Absent on the catch-all install.
  ROUTING_MODE?: string;
  // "true" rejects outbound recipients that are outside this install's domains and config allowlist.
  OUTBOUND_ALLOWLIST_ONLY?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
