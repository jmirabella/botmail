-- Hop count stored at ingest. Quarantine and archive do not remove the row.
ALTER TABLE messages ADD COLUMN hop_count INTEGER NOT NULL DEFAULT 0;
