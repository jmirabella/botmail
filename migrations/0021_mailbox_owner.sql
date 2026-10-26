-- Who created the mailbox, as a verified Cloudflare Access email.
-- Nullable so every existing row stays unowned. Connecting to an existing mailbox does not write this column.

ALTER TABLE bots ADD COLUMN owner_email TEXT;
