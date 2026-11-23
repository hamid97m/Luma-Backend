-- AI gender guesses, for ADMIN REVIEW ONLY (never used to reject or pause):
-- the apparent gender in the main photo, the usual gender of the name, and
-- when an admin last cleared a user's gender flag.

ALTER TABLE photo_ai_checks ADD COLUMN apparent_gender text
  CHECK (apparent_gender IN ('man','woman','unclear'));
ALTER TABLE profile_text_checks ADD COLUMN name_gender text
  CHECK (name_gender IN ('man','woman','unisex','unknown'));
ALTER TABLE users ADD COLUMN gender_review_dismissed_at timestamptz;
