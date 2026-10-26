-- Inbound sender checks. Quarantine keeps the message; nothing here is deleted.
ALTER TABLE messages ADD COLUMN auth_result TEXT;
ALTER TABLE messages ADD COLUMN auth_passed INTEGER;
ALTER TABLE messages ADD COLUMN quarantine_reason TEXT;
