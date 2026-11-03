-- Signup-funnel telemetry: where new users drop off during onboarding.
-- Written without auth, so only allowlisted values go in; never user-typed content.

CREATE TABLE signup_events (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  step text,
  detail text,
  platform text,
  locale text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX signup_events_created_at_idx ON signup_events (created_at);
CREATE INDEX signup_events_name_created_at_idx ON signup_events (name, created_at);
