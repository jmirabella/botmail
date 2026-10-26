-- One row per stamp id per mailbox. The first inbound use is kept.
-- A later copy of the same stamp is not stored again. Rows are not deleted.
CREATE TABLE inbound_stamps (
  stamp_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (stamp_id, bot_id)
);
