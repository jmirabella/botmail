-- Soft delete. Bots, domains, and routes stay in D1 so mail, notes, and addresses can be restored.
-- deleted_at NULL means active. ADD COLUMN leaves every existing row active (the new value is NULL).
-- Nothing in the Worker deletes these rows, and there is no purge job.

ALTER TABLE bots ADD COLUMN deleted_at TEXT;
ALTER TABLE routes ADD COLUMN deleted_at TEXT;
ALTER TABLE mail_domains ADD COLUMN deleted_at TEXT;
