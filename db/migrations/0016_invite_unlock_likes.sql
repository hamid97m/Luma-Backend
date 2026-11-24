-- Invite a (woman) friend -> see everyone who liked you for 7 days.
ALTER TABLE users ADD COLUMN likes_unlocked_until timestamptz;
-- When this friend's like-unlock was paid to the referrer (once per friend).
ALTER TABLE referrals ADD COLUMN likes_rewarded_at timestamptz;
