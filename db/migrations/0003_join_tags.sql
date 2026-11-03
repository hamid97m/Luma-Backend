-- Ad links: the owner writes `t.me/<bot>?start=<tag>` by hand, one tag per ad.
-- Tags are not registered anywhere; they exist once someone opens the link.
-- Separate from the referral program on purpose (no shared tables or rewards).

-- One row per person per tag, written at /start, before any users row exists.
CREATE TABLE join_tag_starts (
  tag text NOT NULL,
  telegram_id bigint NOT NULL,
  existing_user boolean NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag, telegram_id)
);

CREATE INDEX join_tag_starts_telegram_id_idx ON join_tag_starts (telegram_id);

ALTER TABLE users ADD COLUMN join_tag text;

CREATE INDEX users_join_tag_idx ON users (join_tag);
