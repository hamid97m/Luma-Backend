-- Web login: users can exist without a Telegram account (email / Google sign-in).

ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN google_sub text;

ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
ALTER TABLE users ADD CONSTRAINT users_google_sub_key UNIQUE (google_sub);
ALTER TABLE users ADD CONSTRAINT users_has_identity
  CHECK (telegram_id IS NOT NULL OR email IS NOT NULL OR google_sub IS NOT NULL);

CREATE TABLE email_login_codes (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_login_codes_email_created_idx ON email_login_codes (email, created_at DESC);
