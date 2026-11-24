-- AI review of user reports (DeepSeek): auto-ban / temporary suspension, with
-- an admin switch (off | review | auto) and an audit log of every AI result.
-- 'resolved_suspended' is only used by later transactions (never in this file),
-- so adding the enum value inside the migration transaction is fine on PG16.

ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'resolved_suspended';

ALTER TABLE users ADD COLUMN suspended_until timestamptz;

ALTER TABLE moderation_config
  ADD COLUMN report_ai_mode text NOT NULL DEFAULT 'auto' CHECK (report_ai_mode IN ('off','review','auto')),
  ADD COLUMN report_suspend_days integer NOT NULL DEFAULT 3 CHECK (report_suspend_days BETWEEN 1 AND 365);

CREATE TABLE report_ai_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL,                -- off|review|auto at the time
  verdict text NOT NULL,             -- ban|suspend|would_ban|would_suspend|not_valid|unverified|unclear|skipped|error
  category text,
  quote text,
  explanation text,
  skip_reason text,
  evidence_count integer,
  reporter_notified_at timestamptz,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_ai_checks_report ON report_ai_checks (report_id);
CREATE INDEX idx_report_ai_checks_reporter ON report_ai_checks (reporter_id, created_at DESC);
CREATE INDEX idx_report_ai_checks_created ON report_ai_checks (created_at DESC);
