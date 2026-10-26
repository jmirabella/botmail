-- Bots already disabled (enabled = 0, not archived) kept their API key, webhook
-- ciphertext, queued deliveries, and connector. Clear them the same way a disable does.
-- KV grants cannot be revoked from SQL. revoked_at is what blocks those tokens.
UPDATE bots
SET api_key_hash = NULL, webhook_key_ct = NULL, webhook_key_iv = NULL
WHERE enabled = 0 AND deleted_at IS NULL;

UPDATE webhook_deliveries
SET status = 'cancelled',
    last_error = 'bot disabled',
    updated_at = '2026-10-22T00:00:00.000Z'
WHERE status IN ('pending', 'failed')
  AND bot_id IN (SELECT id FROM bots WHERE enabled = 0 AND deleted_at IS NULL);

UPDATE oauth_connection
SET revoked_at = '2026-10-22T00:00:00.000Z'
WHERE revoked_at IS NULL
  AND bot_id IN (SELECT id FROM bots WHERE enabled = 0 AND deleted_at IS NULL);

-- No connector row yet: still record the revoke so an old authorization code cannot claim one later.
INSERT INTO oauth_connection (bot_id, grant_id, created_at, revoked_at)
SELECT id, 'revoked', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z'
FROM bots
WHERE enabled = 0 AND deleted_at IS NULL
  AND id NOT IN (SELECT bot_id FROM oauth_connection);

UPDATE webhook_setup_codes
SET used_at = '2026-10-22T00:00:00.000Z'
WHERE used_at IS NULL
  AND bot_id IN (SELECT id FROM bots WHERE enabled = 0 AND deleted_at IS NULL);
