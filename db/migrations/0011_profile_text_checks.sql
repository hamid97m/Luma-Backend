-- AI / regex review of user-written profile text (name, bio, icebreaker answer).
-- One row per verdict; an approved row also caches that exact text for the
-- user+field so it is never re-sent to DeepSeek.

CREATE TABLE profile_text_checks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field             text NOT NULL CHECK (field IN ('name','bio','icebreaker_answer')),
  text              text NOT NULL,
  approved          boolean NOT NULL,
  reason            text,
  source            text NOT NULL CHECK (source IN ('regex','ai')),
  prompt_tokens     integer,
  completion_tokens integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profile_text_checks_created ON profile_text_checks (created_at DESC);
CREATE INDEX idx_profile_text_checks_user ON profile_text_checks (user_id, created_at DESC);
