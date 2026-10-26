-- A revoked connector stays as a row. Reconnect updates it. Nothing here is deleted.
ALTER TABLE oauth_connection ADD COLUMN revoked_at TEXT;

-- Archived mailboxes must not keep a live connector across restore.
UPDATE oauth_connection
SET revoked_at = '2026-10-22T00:00:00.000Z'
WHERE revoked_at IS NULL
  AND bot_id IN (SELECT id FROM bots WHERE deleted_at IS NOT NULL);
