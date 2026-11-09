-- Why users delete their account (optional answer on the delete screen).
-- One row per deletion, answered or not; gender/premium/age-of-account are
-- snapshotted at delete time so stats survive later changes to the users row.

CREATE TABLE account_deletion_reasons (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  note text,
  gender text,
  was_premium boolean,
  days_since_signup int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_deletion_reasons_created_at_idx ON account_deletion_reasons (created_at);
