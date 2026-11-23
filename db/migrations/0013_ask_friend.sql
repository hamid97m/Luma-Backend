-- "Ask a friend" (نظر دوستت رو بپرس): a woman shows one discovery profile to
-- 1-3 friends and gets their verdict. The target is never told.
-- Non-member advisors have no users row: they're identified by the Telegram
-- account that claimed the link (advisor_tg_id) and authenticate with initData.

CREATE TABLE ask_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (question IN ('reply','date','red_flag')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_reason text,            -- liked | passed | expired | target_gone | requester_gone | blocked
  last_answer_notified_at timestamptz
);

CREATE TABLE ask_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES ask_requests(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('member','link')),
  recipient_id uuid REFERENCES users(id) ON DELETE SET NULL,
  advisor_tg_id bigint,
  advisor_name text,
  advisor_gender text CHECK (advisor_gender IN ('female','male')),
  token_hash bytea UNIQUE,
  seen_at timestamptz,
  verdict text CHECK (verdict IN ('yes','unsure','no')),
  note varchar(300),
  answered_at timestamptz,
  reminded_at timestamptz,
  foreign_open_at timestamptz,
  nudged_at timestamptz,
  -- Telegram accounts turned away (declared male): the claim was released so the
  -- link stays usable, and these ids never claim it again.
  rejected_tg_ids bigint[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ask_recipients_request_id_idx ON ask_recipients (request_id);
CREATE INDEX ask_recipients_recipient_id_idx ON ask_recipients (recipient_id);
CREATE INDEX ask_recipients_advisor_tg_id_idx ON ask_recipients (advisor_tg_id);
CREATE INDEX ask_requests_requester_status_idx ON ask_requests (requester_id, status);
CREATE INDEX ask_requests_target_id_idx ON ask_requests (target_id);

CREATE TABLE ask_events (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  request_id uuid,
  recipient_kind text,
  user_id uuid,
  telegram_id bigint,
  props jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ask_events_name_created_idx ON ask_events (name, created_at);

ALTER TABLE users ADD COLUMN invited_by uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_invited_by_idx ON users (invited_by) WHERE invited_by IS NOT NULL;
