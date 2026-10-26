-- One-shot. Mailboxes archived before archive cleared the webhook key can still
-- be retried. Null the ciphertext and cancel queued deliveries. Rows stay.
UPDATE bots
SET webhook_key_ct = NULL, webhook_key_iv = NULL
WHERE deleted_at IS NOT NULL;

UPDATE webhook_deliveries
SET status = 'cancelled',
    last_error = 'bot archived',
    updated_at = '2026-10-22T00:00:00.000Z'
WHERE status IN ('pending', 'failed')
  AND bot_id IN (SELECT id FROM bots WHERE deleted_at IS NOT NULL);
