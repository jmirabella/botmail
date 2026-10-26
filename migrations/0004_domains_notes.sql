-- Multiple mail domains, per-mailbox notes, and addresses unique per (local part, domain).
-- bots and routes are rebuilt because SQLite cannot drop the column-level UNIQUE on
-- address_local / local_part. Every existing row is copied unchanged.
-- Existing rows get domain '' (the default domain). The D1 file cannot know MAIL_DOMAIN,
-- so the Worker and `npm run setup` replace '' with it before anything reads by domain.

CREATE TABLE mail_domains (
  domain TEXT PRIMARY KEY,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  zone_id TEXT,
  zone_name TEXT,
  status TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bots_next (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  address_local TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  api_key_hash TEXT UNIQUE,
  webhook_url TEXT,
  webhook_key_ct TEXT,
  webhook_key_iv TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO bots_next (
  id, display_name, address_local, domain, notes, api_key_hash, webhook_url, webhook_key_ct, webhook_key_iv,
  enabled, created_at, updated_at
)
SELECT id, display_name, address_local, '', '', api_key_hash, webhook_url, webhook_key_ct, webhook_key_iv,
       enabled, created_at, updated_at
FROM bots;

DROP TABLE bots;
ALTER TABLE bots_next RENAME TO bots;

CREATE UNIQUE INDEX bots_address ON bots (address_local, domain);
CREATE INDEX bots_local ON bots (address_local);

CREATE TABLE routes_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('alias', 'forward')),
  local_part TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO routes_next (id, kind, local_part, domain, target, enabled, created_at, updated_at)
SELECT id, kind, local_part, '', target, enabled, created_at, updated_at FROM routes;

DROP TABLE routes;
ALTER TABLE routes_next RENAME TO routes;

CREATE UNIQUE INDEX routes_address ON routes (local_part, domain);
CREATE INDEX routes_local ON routes (local_part, domain, enabled);

INSERT OR IGNORE INTO settings (key, value) VALUES ('unique_bot_names', '');
