-- Cloudflare Email Routing X-Cf-Spamh-Score (0-5). Existing rows stay null.
-- Nothing is backfilled or deleted.
ALTER TABLE messages ADD COLUMN spam_score INTEGER;
