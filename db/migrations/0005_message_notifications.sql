-- New-message notifications actually sent, per recipient and chat. Drives the
-- bot-DM rule (at most one per chat per 10 minutes unless the user was active
-- since). Rows older than 2 days are pruned on the next insert for that user.

CREATE TABLE message_notifications (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id  uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  channel   text NOT NULL CHECK (channel IN ('push','bot')),
  sent_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_notifications_user_sent_idx ON message_notifications (user_id, sent_at);
CREATE INDEX message_notifications_user_match_sent_idx ON message_notifications (user_id, match_id, sent_at);
