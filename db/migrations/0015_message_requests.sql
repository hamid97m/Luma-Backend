-- Message requests: a direct chat to a woman waits in her Requests inbox until
-- she accepts (→ match + chat) or ignores it. The sender is never told "ignored".
-- One request per (sender, recipient), ever. 'expired' is written lazily (a
-- pending request older than 7 days).
--
-- Safe to apply while the old code still runs: it never touches the new table.

CREATE TABLE message_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','ignored','expired')),
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK (sender_id <> recipient_id)
);

CREATE UNIQUE INDEX message_requests_pair_idx ON message_requests (sender_id, recipient_id);
CREATE INDEX message_requests_recipient_idx ON message_requests (recipient_id, status, created_at);
-- Sender side: "waiting" list and the cap on it.
CREATE INDEX message_requests_sender_idx ON message_requests (sender_id, created_at);
