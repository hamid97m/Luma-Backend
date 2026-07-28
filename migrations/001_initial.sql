CREATE TYPE gender_type  AS ENUM ('man', 'woman');
CREATE TYPE looking_type AS ENUM ('men', 'women', 'both');
CREATE TYPE swipe_dir    AS ENUM ('like', 'pass');

CREATE TABLE users (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint       UNIQUE NOT NULL,
  username    text,
  name        text         NOT NULL,
  age         int          NOT NULL,
  gender      gender_type  NOT NULL,
  looking_for looking_type NOT NULL,
  bio         text,
  is_active   boolean      DEFAULT true,
  created_at  timestamptz  DEFAULT now(),
  last_active timestamptz  DEFAULT now()
);

CREATE TABLE user_photos (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url        text        NOT NULL,
  position   int         NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, position)
);

CREATE TABLE swipes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  swiper_id  uuid        NOT NULL REFERENCES users(id),
  swiped_id  uuid        NOT NULL REFERENCES users(id),
  direction  swipe_dir   NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(swiper_id, swiped_id)
);

CREATE TABLE matches (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id   uuid        NOT NULL REFERENCES users(id),
  user2_id   uuid        NOT NULL REFERENCES users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user1_id, user2_id)
);

CREATE TABLE blocks (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid        NOT NULL REFERENCES users(id),
  blocked_id uuid        NOT NULL REFERENCES users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX idx_swipes_match_check ON swipes (swiped_id, direction);
CREATE INDEX idx_users_last_active  ON users (last_active DESC);
CREATE INDEX idx_photos_user_pos    ON user_photos (user_id, position);

-- Grants for Supabase roles
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon;
