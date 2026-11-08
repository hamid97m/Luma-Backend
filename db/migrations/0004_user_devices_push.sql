-- Per-user client devices (Telegram Mini App, web, Android) with an optional FCM push
-- token, and push support on admin broadcasts (channel + title, kind 'push').

CREATE TABLE user_devices (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     text NOT NULL,
  platform      text NOT NULL CHECK (platform IN ('telegram','web','android')),
  app_version   text,
  device_model  text,
  os            text,
  user_agent    text,
  push_token    text,
  push_token_at timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX user_devices_user_id_idx ON user_devices (user_id);
CREATE UNIQUE INDEX user_devices_push_token_idx ON user_devices (push_token) WHERE push_token IS NOT NULL;

ALTER TABLE broadcasts ADD COLUMN channel text NOT NULL DEFAULT 'bot' CHECK (channel IN ('bot','push'));
ALTER TABLE broadcasts ADD COLUMN title text;

ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_kind_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_kind_check CHECK (kind IN ('text','forward','push'));
