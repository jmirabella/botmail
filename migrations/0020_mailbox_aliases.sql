-- Mailbox aliases, one address registry, and forward-on-disable.
-- Additive only. messages.via_alias is left null on existing rows; no message is copied or updated.
-- Existing mailbox and route addresses are copied into address_registry so the unique key
-- covers them. Rows with an empty domain are filled later by the Worker, which then registers them.

CREATE TABLE address_registry (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mailbox', 'alias', 'forward')),
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO address_registry (address, kind, owner_id, created_at)
SELECT lower(address_local) || '@' || lower(domain), 'mailbox', id, created_at
FROM bots
WHERE address_local != '' AND domain != '';

INSERT INTO address_registry (address, kind, owner_id, created_at)
SELECT lower(local_part) || '@' || lower(domain),
       CASE WHEN kind = 'alias' THEN 'alias' ELSE 'forward' END,
       id,
       created_at
FROM routes
WHERE local_part != '' AND domain != ''
  AND NOT EXISTS (
    SELECT 1 FROM address_registry
    WHERE address = lower(routes.local_part) || '@' || lower(routes.domain)
  );

CREATE TABLE alias_targets (
  route_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (route_id, bot_id)
);

CREATE INDEX alias_targets_bot ON alias_targets (bot_id);

INSERT INTO alias_targets (route_id, bot_id, created_at)
SELECT id, target, created_at
FROM routes
WHERE kind = 'alias' AND target != '';

ALTER TABLE messages ADD COLUMN via_alias TEXT;
ALTER TABLE bots ADD COLUMN forward_to TEXT;
