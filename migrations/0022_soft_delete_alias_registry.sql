-- Soft-delete columns for alias targets and the address registry.
-- Additive only. Existing rows stay active: removed_at is NULL.
-- alias_targets is already indexed on route_id by PRIMARY KEY (route_id, bot_id),
-- so this migration does not add another index.

ALTER TABLE alias_targets ADD COLUMN removed_at TEXT;
ALTER TABLE address_registry ADD COLUMN removed_at TEXT;
