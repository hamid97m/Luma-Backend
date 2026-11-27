-- Who the invite-friends program is open to (as inviters) while it is enabled.
ALTER TABLE referral_config ADD COLUMN audience text NOT NULL DEFAULT 'all'
  CHECK (audience IN ('all', 'women', 'men'));
