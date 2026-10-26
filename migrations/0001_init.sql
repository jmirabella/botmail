-- bot-mail schema. Webhook sender keys are AES-GCM ciphertext, never plaintext.
-- API keys are SHA-256 hashes. The admin key stays a Worker secret.

CREATE TABLE bots (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  address_local TEXT NOT NULL UNIQUE,
  api_key_hash TEXT UNIQUE,
  webhook_url TEXT,
  webhook_key_ct TEXT,
  webhook_key_iv TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  message_id_header TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  folder TEXT NOT NULL,
  status TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addrs TEXT NOT NULL,
  cc_addrs TEXT,
  bcc_addrs TEXT,
  subject TEXT,
  message_date TEXT,
  thread_id TEXT,
  in_reply_to TEXT,
  references_header TEXT,
  snippet TEXT,
  text_body TEXT,
  html_body TEXT,
  body_truncated INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  plus_tag TEXT,
  r2_key TEXT,
  raw_size INTEGER,
  approval_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX messages_dedupe
  ON messages (bot_id, message_id_header, direction);

CREATE INDEX messages_bot_date ON messages (bot_id, message_date);
CREATE INDEX messages_bot_thread ON messages (bot_id, thread_id);
CREATE INDEX messages_bot_folder ON messages (bot_id, folder, status);
CREATE INDEX messages_status ON messages (status, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  disposition TEXT
);

CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX webhook_drain ON webhook_deliveries (status, updated_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('send_policy', 'strict');
INSERT INTO settings (key, value) VALUES ('send_allowlist', '[]');
