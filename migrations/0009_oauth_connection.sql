-- One active OAuth connection per mailbox. Grants themselves live in OAUTH_KV.
-- bot_id is the lock: a second grant for the same mailbox loses the insert.
CREATE TABLE IF NOT EXISTS oauth_connection (
  bot_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
