-- Inline images are attachments too. attachments_checked marks a stored .eml
-- the backfill has already parsed, including messages that had no files.
ALTER TABLE attachments ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN attachments_checked INTEGER NOT NULL DEFAULT 0;
