-- Last time an OAuth connector called /mcp. Grants themselves live in OAUTH_KV.
CREATE TABLE IF NOT EXISTS oauth_grant_use (
  grant_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_grant_use_bot ON oauth_grant_use (bot_id);
