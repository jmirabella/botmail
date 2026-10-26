-- Inbox pages by received time, then id. Received time is the Date header,
-- or created_at when that header is missing. Forward-only: index only.
CREATE INDEX messages_received_id ON messages (COALESCE(message_date, created_at), id);
