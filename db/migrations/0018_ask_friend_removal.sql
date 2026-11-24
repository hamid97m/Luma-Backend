-- Removed friendships keep their row (removed_at set): the pair must not come back
-- from old asks or invited_by. Cleared only when one of them later answers a share
-- link created after the removal.
ALTER TABLE ask_friends ADD COLUMN removed_at timestamptz;
