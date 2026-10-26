-- One-time codes a mailbox uses to save its routine webhook from a shell.
-- The code itself is not stored. code_hash is SHA-256.
CREATE TABLE webhook_setup_codes (
  code_hash TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX webhook_setup_codes_bot ON webhook_setup_codes (bot_id);

-- Fixed one-minute windows for POST /webhook-setup, keyed by client IP.
CREATE TABLE webhook_setup_hits (
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (ip, window_start)
);
