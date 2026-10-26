-- One charge per stamp slot or automated reply, taken at send time.
-- Released rows stay. Nothing in this table is deleted.
CREATE TABLE outbound_quota (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  recipient TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX outbound_quota_stamp ON outbound_quota (bot_id, kind, status, reserved_at);
CREATE INDEX outbound_quota_reply ON outbound_quota (bot_id, kind, recipient, status, reserved_at);
CREATE INDEX outbound_quota_attempt ON outbound_quota (bot_id, attempt_id);
