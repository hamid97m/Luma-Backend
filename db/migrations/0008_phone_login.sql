-- Native-app phone login: Iranian mobile + SMS code (Mediana). Stored as '09xxxxxxxxx'.

ALTER TABLE users ADD COLUMN phone text;
ALTER TABLE users ADD CONSTRAINT users_phone_key UNIQUE (phone);

-- A deleted account gives up its phone (numbers get reassigned in Iran), so a
-- deleted phone-only row may be left with no identity at all.
ALTER TABLE users DROP CONSTRAINT users_has_identity;
ALTER TABLE users ADD CONSTRAINT users_has_identity
  CHECK (telegram_id IS NOT NULL OR email IS NOT NULL OR google_sub IS NOT NULL OR phone IS NOT NULL
         OR deleted_at IS NOT NULL);

-- One row per SMS sent. Also the source of the send rate limits.
CREATE TABLE phone_otp_codes (
  id bigserial PRIMARY KEY,
  phone text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('login', 'link')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX phone_otp_codes_phone_created_idx ON phone_otp_codes (phone, created_at DESC);
CREATE INDEX phone_otp_codes_user_created_idx ON phone_otp_codes (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX phone_otp_codes_created_idx ON phone_otp_codes (created_at);
