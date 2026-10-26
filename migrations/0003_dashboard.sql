-- Dashboard routing, branding, and the unknown-recipient policy.
-- 0001 stays unchanged because it may already be applied.

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('alias', 'forward')),
  local_part TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX routes_local ON routes (local_part, enabled);

INSERT INTO settings (key, value) VALUES ('unknown_policy', 'unrouted');
INSERT INTO settings (key, value) VALUES ('unknown_bot', '');
INSERT INTO settings (key, value) VALUES ('brand_name', '');
INSERT INTO settings (key, value) VALUES ('brand_logo', '');
INSERT INTO settings (key, value) VALUES ('brand_accent', '');
INSERT INTO settings (key, value) VALUES ('send_policy_source', 'config');
