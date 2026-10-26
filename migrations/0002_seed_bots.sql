-- System mailbox for recipients on MAIL_DOMAIN that are not a configured bot.
-- Group mailboxes are inserted by `npm run setup` from bot-mail.config.json.
-- Re-running is safe (INSERT OR IGNORE). _unrouted cannot send and has no API key.

INSERT OR IGNORE INTO bots (id, display_name, address_local, enabled, created_at, updated_at)
VALUES
  ('_unrouted', 'Unrouted', '_unrouted', 0, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
