-- "Ask a friend": friendships outlive the asks they came from (asks and answers
-- are purged 30 days after closing). Only the pair is kept: no question, verdict
-- or note. One row per pair, smaller id first.
CREATE TABLE ask_friends (
  user_a uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

CREATE INDEX ask_friends_user_b_idx ON ask_friends (user_b);
