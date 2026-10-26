-- Remember the last revoke after a new grant clears revoked_at.
-- Column only. No rows are updated or deleted.
ALTER TABLE oauth_connection ADD COLUMN last_revoked_at TEXT;
