-- Luma database schema — plain Postgres.
-- Baseline schema (public schema only), loaded by src/migrate.ts on an empty
-- database. Later changes go in db/migrations/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────

CREATE TYPE gender_type AS ENUM ('man', 'woman', 'nonbinary');
CREATE TYPE looking_type AS ENUM ('men', 'women', 'both', 'everyone');
CREATE TYPE msg_sender AS ENUM ('user', 'admin');
CREATE TYPE report_context AS ENUM ('discovery', 'chat');
CREATE TYPE report_reason AS ENUM ('fake', 'inappropriate', 'harassment', 'spam', 'other');
CREATE TYPE report_status AS ENUM ('pending', 'resolved_banned', 'dismissed', 'resolved_reuploaded');
CREATE TYPE swipe_dir AS ENUM ('like', 'pass');
CREATE TYPE ticket_status AS ENUM ('open', 'closed');

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE admins (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  last_login_at timestamp with time zone
);

CREATE TABLE blocks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE broadcasts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  created_by uuid,
  created_by_username text,
  message text NOT NULL,
  filters jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'running'::text NOT NULL,
  total_recipients integer DEFAULT 0 NOT NULL,
  sent_count integer DEFAULT 0 NOT NULL,
  failed_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  finished_at timestamp with time zone,
  error text,
  kind text DEFAULT 'text'::text NOT NULL,
  source_chat_id text,
  source_message_id bigint
);

CREATE TABLE city_lookups (
  key text NOT NULL,
  city text,
  country text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE fake_liker_config (
  id boolean DEFAULT true NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  max_targets_per_run integer DEFAULT 100 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE fake_liker_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  trigger text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone NOT NULL,
  likes_sent integer DEFAULT 0 NOT NULL,
  matches_created integer DEFAULT 0 NOT NULL,
  salams_sent integer DEFAULT 0 NOT NULL,
  errors integer DEFAULT 0 NOT NULL
);

CREATE TABLE gift_config (
  id boolean DEFAULT true NOT NULL,
  markup_percent integer DEFAULT 33 NOT NULL,
  low_balance_threshold integer DEFAULT 500 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE gift_price_overrides (
  gift_id text NOT NULL,
  charged_stars integer NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE gift_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  buyer_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  context text NOT NULL,
  match_id uuid,
  gift_id text NOT NULL,
  gift_emoji text,
  gift_star_cost integer NOT NULL,
  charged_stars integer NOT NULL,
  markup_stars integer DEFAULT 0 NOT NULL,
  note text,
  status text DEFAULT 'pending_payment'::text NOT NULL,
  telegram_payment_charge_id text,
  intro_status text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  paid_at timestamp with time zone,
  sent_at timestamp with time zone
);

CREATE TABLE like_reveals (
  user_id uuid NOT NULL,
  swiper_id uuid NOT NULL,
  revealed_on date NOT NULL,
  notified_at timestamp with time zone
);

CREATE TABLE matches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  last_message_at timestamp with time zone DEFAULT now()
);

CREATE TABLE messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  match_id uuid NOT NULL,
  sender_id uuid NOT NULL,
  body text,
  created_at timestamp with time zone DEFAULT now(),
  read_at timestamp with time zone,
  edited_at timestamp with time zone,
  reply_to_message_id uuid,
  type text DEFAULT 'text'::text NOT NULL,
  gift_transaction_id uuid,
  icebreaker_answer text
);

CREATE TABLE moderation_config (
  id boolean DEFAULT true NOT NULL,
  photo_report_threshold integer DEFAULT 3 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE photo_ai_checks (
  photo_id uuid NOT NULL,
  user_id uuid NOT NULL,
  approved boolean NOT NULL,
  reason text,
  photo_url text,
  evidence_path text,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE premium_config (
  id boolean DEFAULT true NOT NULL,
  premium_enabled boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  toman_per_star integer DEFAULT 3000 NOT NULL
);

CREATE TABLE premium_plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  price_stars integer NOT NULL,
  discount_percent integer,
  duration_days integer NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  discount_ends_at timestamp with time zone,
  translations jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE premium_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  plan_id uuid,
  plan_title text NOT NULL,
  price_stars integer NOT NULL,
  duration_days integer NOT NULL,
  status text DEFAULT 'pending_payment'::text NOT NULL,
  source text DEFAULT 'purchase'::text NOT NULL,
  telegram_payment_charge_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  paid_at timestamp with time zone,
  provider text DEFAULT 'stars'::text NOT NULL,
  price_toman integer,
  tonpays_invoice_id text,
  tonpays_order_id text,
  tonpays_final_amount integer,
  tonpays_status text
);

CREATE TABLE purchase_message_config (
  id boolean DEFAULT true NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  kind text DEFAULT 'text'::text NOT NULL,
  message text,
  source_chat_id text,
  source_message_id bigint,
  button jsonb,
  active_since timestamp with time zone,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  translations jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE purchase_message_sends (
  user_id uuid NOT NULL,
  status text DEFAULT 'sent'::text NOT NULL,
  sent_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE referral_claims (
  telegram_id bigint NOT NULL,
  code text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE referral_config (
  id boolean DEFAULT true NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE referral_rewards (
  referrer_id uuid NOT NULL,
  milestone integer NOT NULL,
  granted_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE referrals (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  referrer_id uuid NOT NULL,
  referred_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  qualified_at timestamp with time zone
);

CREATE TABLE reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  reporter_id uuid NOT NULL,
  reported_id uuid NOT NULL,
  context report_context NOT NULL,
  reason report_reason NOT NULL,
  note text,
  match_id uuid,
  status report_status DEFAULT 'pending'::report_status NOT NULL,
  resolved_by uuid,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE support_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ticket_id uuid NOT NULL,
  sender msg_sender NOT NULL,
  admin_id uuid,
  body text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  read_by_user_at timestamp with time zone
);

CREATE TABLE support_tickets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  status ticket_status DEFAULT 'open'::ticket_status NOT NULL,
  last_sender msg_sender DEFAULT 'user'::msg_sender NOT NULL,
  last_message_at timestamp with time zone DEFAULT now() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  closed_by uuid,
  closed_at timestamp with time zone
);

CREATE TABLE swipes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  swiper_id uuid NOT NULL,
  swiped_id uuid NOT NULL,
  direction swipe_dir NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE user_photos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  url text NOT NULL,
  "position" integer NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  telegram_id bigint NOT NULL,
  username text,
  name text NOT NULL,
  age integer NOT NULL,
  gender gender_type NOT NULL,
  looking_for looking_type NOT NULL,
  bio text,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  last_active timestamp with time zone DEFAULT now(),
  interests text[] DEFAULT '{}'::text[] NOT NULL,
  location text,
  icebreaker_prompt text,
  icebreaker_answer text,
  deleted_at timestamp with time zone,
  notified_offline_at timestamp with time zone,
  allows_write_to_pm boolean,
  banned_at timestamp with time zone,
  is_seed boolean DEFAULT false NOT NULL,
  awaiting_support_since timestamp with time zone,
  premium_until timestamp with time zone,
  swipe_window_started_at timestamp with time zone,
  swipe_window_count integer DEFAULT 0 NOT NULL,
  likes_seen_at timestamp with time zone,
  paused_at timestamp with time zone,
  direct_chat_window_started_at timestamp with time zone,
  direct_chat_window_count integer DEFAULT 0 NOT NULL,
  referral_code text,
  referred_by uuid,
  bonus_swipes integer DEFAULT 0 NOT NULL,
  locale text,
  geo_city text,
  geo_country text,
  account_status text DEFAULT 'preparing'::text NOT NULL
);

-- ── Primary keys, unique & check constraints ─────────────────────────────

ALTER TABLE admins ADD CONSTRAINT admins_pkey PRIMARY KEY (id);
ALTER TABLE admins ADD CONSTRAINT admins_username_key UNIQUE (username);
ALTER TABLE blocks ADD CONSTRAINT blocks_blocker_id_blocked_id_key UNIQUE (blocker_id, blocked_id);
ALTER TABLE blocks ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'forward'::text])));
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_pkey PRIMARY KEY (id);
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'interrupted'::text])));
ALTER TABLE city_lookups ADD CONSTRAINT city_lookups_pkey PRIMARY KEY (key);
ALTER TABLE fake_liker_config ADD CONSTRAINT fake_liker_config_id_check CHECK ((id = true));
ALTER TABLE fake_liker_config ADD CONSTRAINT fake_liker_config_max_targets_per_run_check CHECK (((max_targets_per_run >= 1) AND (max_targets_per_run <= 1000)));
ALTER TABLE fake_liker_config ADD CONSTRAINT fake_liker_config_pkey PRIMARY KEY (id);
ALTER TABLE fake_liker_runs ADD CONSTRAINT fake_liker_runs_pkey PRIMARY KEY (id);
ALTER TABLE fake_liker_runs ADD CONSTRAINT fake_liker_runs_trigger_check CHECK ((trigger = ANY (ARRAY['schedule'::text, 'manual'::text])));
ALTER TABLE gift_config ADD CONSTRAINT gift_config_id_check CHECK ((id = true));
ALTER TABLE gift_config ADD CONSTRAINT gift_config_low_balance_threshold_check CHECK ((low_balance_threshold >= 0));
ALTER TABLE gift_config ADD CONSTRAINT gift_config_markup_percent_check CHECK ((markup_percent >= 0));
ALTER TABLE gift_config ADD CONSTRAINT gift_config_pkey PRIMARY KEY (id);
ALTER TABLE gift_price_overrides ADD CONSTRAINT gift_price_overrides_charged_stars_check CHECK ((charged_stars > 0));
ALTER TABLE gift_price_overrides ADD CONSTRAINT gift_price_overrides_pkey PRIMARY KEY (gift_id);
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_charged_stars_check CHECK ((charged_stars > 0));
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_context_check CHECK ((context = ANY (ARRAY['chat'::text, 'discovery'::text])));
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_gift_star_cost_check CHECK ((gift_star_cost > 0));
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_intro_status_check CHECK ((intro_status = ANY (ARRAY['pending'::text, 'accepted'::text, 'dismissed'::text])));
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_pkey PRIMARY KEY (id);
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'paid'::text, 'sent'::text, 'send_failed'::text, 'refunded'::text])));
ALTER TABLE like_reveals ADD CONSTRAINT like_reveals_pkey PRIMARY KEY (user_id, revealed_on);
ALTER TABLE matches ADD CONSTRAINT matches_pkey PRIMARY KEY (id);
ALTER TABLE matches ADD CONSTRAINT matches_user1_id_user2_id_key UNIQUE (user1_id, user2_id);
ALTER TABLE messages ADD CONSTRAINT messages_body_or_gift CHECK ((((type = 'text'::text) AND (body IS NOT NULL)) OR ((type = 'gift'::text) AND (gift_transaction_id IS NOT NULL)) OR ((type = 'icebreaker'::text) AND (body IS NOT NULL))));
ALTER TABLE messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK ((type = ANY (ARRAY['text'::text, 'gift'::text, 'icebreaker'::text])));
ALTER TABLE moderation_config ADD CONSTRAINT moderation_config_id_check CHECK ((id = true));
ALTER TABLE moderation_config ADD CONSTRAINT moderation_config_photo_report_threshold_check CHECK ((photo_report_threshold >= 0));
ALTER TABLE moderation_config ADD CONSTRAINT moderation_config_pkey PRIMARY KEY (id);
ALTER TABLE photo_ai_checks ADD CONSTRAINT photo_ai_checks_pkey PRIMARY KEY (photo_id);
ALTER TABLE premium_config ADD CONSTRAINT premium_config_id_check CHECK ((id = true));
ALTER TABLE premium_config ADD CONSTRAINT premium_config_pkey PRIMARY KEY (id);
ALTER TABLE premium_config ADD CONSTRAINT premium_config_toman_per_star_check CHECK ((toman_per_star > 0));
ALTER TABLE premium_plans ADD CONSTRAINT premium_plans_discount_percent_check CHECK (((discount_percent >= 1) AND (discount_percent <= 90)));
ALTER TABLE premium_plans ADD CONSTRAINT premium_plans_duration_days_check CHECK ((duration_days > 0));
ALTER TABLE premium_plans ADD CONSTRAINT premium_plans_pkey PRIMARY KEY (id);
ALTER TABLE premium_plans ADD CONSTRAINT premium_plans_price_stars_check CHECK ((price_stars > 0));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_duration_days_check CHECK ((duration_days > 0));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_pkey PRIMARY KEY (id);
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_price_stars_check CHECK ((price_stars >= 0));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_provider_check CHECK ((provider = ANY (ARRAY['stars'::text, 'tonpays'::text])));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_source_check CHECK ((source = ANY (ARRAY['purchase'::text, 'admin_grant'::text, 'referral'::text])));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'paid'::text, 'refunded'::text, 'canceled'::text, 'paid_grant_failed'::text])));
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_tonpays_invoice_id_key UNIQUE (tonpays_invoice_id);
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_tonpays_order_id_key UNIQUE (tonpays_order_id);
ALTER TABLE purchase_message_config ADD CONSTRAINT purchase_message_config_id_check CHECK ((id = true));
ALTER TABLE purchase_message_config ADD CONSTRAINT purchase_message_config_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'forward'::text])));
ALTER TABLE purchase_message_config ADD CONSTRAINT purchase_message_config_pkey PRIMARY KEY (id);
ALTER TABLE purchase_message_sends ADD CONSTRAINT purchase_message_sends_pkey PRIMARY KEY (user_id);
ALTER TABLE purchase_message_sends ADD CONSTRAINT purchase_message_sends_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'blocked'::text])));
ALTER TABLE referral_claims ADD CONSTRAINT referral_claims_pkey PRIMARY KEY (telegram_id);
ALTER TABLE referral_config ADD CONSTRAINT referral_config_id_check CHECK ((id = true));
ALTER TABLE referral_config ADD CONSTRAINT referral_config_pkey PRIMARY KEY (id);
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_pkey PRIMARY KEY (referrer_id, milestone);
ALTER TABLE referrals ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);
ALTER TABLE referrals ADD CONSTRAINT referrals_referred_id_key UNIQUE (referred_id);
ALTER TABLE reports ADD CONSTRAINT reports_pkey PRIMARY KEY (id);
ALTER TABLE support_messages ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);
ALTER TABLE swipes ADD CONSTRAINT swipes_pkey PRIMARY KEY (id);
ALTER TABLE swipes ADD CONSTRAINT swipes_swiper_id_swiped_id_key UNIQUE (swiper_id, swiped_id);
ALTER TABLE user_photos ADD CONSTRAINT user_photos_pkey PRIMARY KEY (id);
ALTER TABLE user_photos ADD CONSTRAINT user_photos_user_id_position_key UNIQUE (user_id, "position");
ALTER TABLE users ADD CONSTRAINT users_account_status_check CHECK ((account_status = ANY (ARRAY['preparing'::text, 'active'::text])));
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['fa'::text, 'en'::text, 'ar'::text])));
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE users ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);
ALTER TABLE users ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);

-- ── Foreign keys ─────────────────────────────────────────────────────────

ALTER TABLE blocks ADD CONSTRAINT blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES users(id);
ALTER TABLE blocks ADD CONSTRAINT blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES users(id);
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_created_by_fkey FOREIGN KEY (created_by) REFERENCES admins(id);
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES users(id);
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
ALTER TABLE gift_transactions ADD CONSTRAINT gift_transactions_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES users(id);
ALTER TABLE like_reveals ADD CONSTRAINT like_reveals_swiper_id_fkey FOREIGN KEY (swiper_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE like_reveals ADD CONSTRAINT like_reveals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE matches ADD CONSTRAINT matches_user1_id_fkey FOREIGN KEY (user1_id) REFERENCES users(id);
ALTER TABLE matches ADD CONSTRAINT matches_user2_id_fkey FOREIGN KEY (user2_id) REFERENCES users(id);
ALTER TABLE messages ADD CONSTRAINT messages_gift_transaction_id_fkey FOREIGN KEY (gift_transaction_id) REFERENCES gift_transactions(id);
ALTER TABLE messages ADD CONSTRAINT messages_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id);
ALTER TABLE photo_ai_checks ADD CONSTRAINT photo_ai_checks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES premium_plans(id) ON DELETE SET NULL;
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE purchase_message_sends ADD CONSTRAINT purchase_message_sends_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE referral_rewards ADD CONSTRAINT referral_rewards_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE referrals ADD CONSTRAINT referrals_referred_id_fkey FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE referrals ADD CONSTRAINT referrals_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT reports_match_id_fkey FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;
ALTER TABLE reports ADD CONSTRAINT reports_reported_id_fkey FOREIGN KEY (reported_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reports ADD CONSTRAINT reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES admins(id);
ALTER TABLE support_messages ADD CONSTRAINT support_messages_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admins(id);
ALTER TABLE support_messages ADD CONSTRAINT support_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES admins(id);
ALTER TABLE support_tickets ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE swipes ADD CONSTRAINT swipes_swiped_id_fkey FOREIGN KEY (swiped_id) REFERENCES users(id);
ALTER TABLE swipes ADD CONSTRAINT swipes_swiper_id_fkey FOREIGN KEY (swiper_id) REFERENCES users(id);
ALTER TABLE user_photos ADD CONSTRAINT user_photos_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL;

-- ── Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX idx_blocks_blocked ON blocks USING btree (blocked_id);
CREATE INDEX idx_broadcasts_created_at ON broadcasts USING btree (created_at DESC);
CREATE INDEX idx_fake_liker_runs_started_at ON fake_liker_runs USING btree (started_at DESC);
CREATE INDEX idx_gift_tx_buyer_created ON gift_transactions USING btree (buyer_id, created_at DESC);
CREATE INDEX idx_gift_tx_recipient_intro ON gift_transactions USING btree (recipient_id, intro_status);
CREATE INDEX idx_matches_last_message_at ON matches USING btree (last_message_at DESC);
CREATE INDEX idx_matches_user2 ON matches USING btree (user2_id);
CREATE INDEX idx_messages_match_created ON messages USING btree (match_id, created_at);
CREATE INDEX idx_messages_reply_to ON messages USING btree (reply_to_message_id);
CREATE INDEX idx_messages_sender_match ON messages USING btree (sender_id, match_id);
CREATE INDEX idx_messages_unread ON messages USING btree (match_id, sender_id) WHERE (read_at IS NULL);
CREATE INDEX idx_photo_ai_checks_created ON photo_ai_checks USING btree (created_at DESC);
CREATE INDEX idx_photo_ai_checks_user ON photo_ai_checks USING btree (user_id, created_at DESC);
CREATE INDEX idx_photos_user_pos ON user_photos USING btree (user_id, "position");
CREATE INDEX idx_premium_tx_status_created ON premium_transactions USING btree (status, created_at DESC);
CREATE INDEX idx_premium_tx_tonpays_pending ON premium_transactions USING btree (created_at) WHERE ((provider = 'tonpays'::text) AND (status = 'pending_payment'::text));
CREATE INDEX idx_premium_tx_user ON premium_transactions USING btree (user_id);
CREATE UNIQUE INDEX idx_reports_pending_unique ON reports USING btree (reporter_id, reported_id) WHERE (status = 'pending'::report_status);
CREATE INDEX idx_reports_reported_status ON reports USING btree (reported_id, status);
CREATE INDEX idx_reports_status_created ON reports USING btree (status, created_at DESC);
CREATE INDEX idx_support_messages_ticket ON support_messages USING btree (ticket_id, created_at);
CREATE INDEX idx_support_tickets_queue ON support_tickets USING btree (status, last_sender, last_message_at DESC);
CREATE INDEX idx_support_tickets_user ON support_tickets USING btree (user_id, last_message_at DESC);
CREATE INDEX idx_swipes_match_check ON swipes USING btree (swiped_id, direction);
CREATE INDEX idx_users_geo ON users USING btree (geo_country, geo_city);
CREATE INDEX idx_users_last_active ON users USING btree (last_active DESC);
CREATE INDEX referrals_referrer_idx ON referrals USING btree (referrer_id);

-- ── Functions, views, triggers ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION bump_match_last_message_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  begin
    update matches
      set last_message_at = new.created_at
      where id = new.match_id
        and (last_message_at is null or new.created_at > last_message_at);
    return new;
  end;
$function$;

CREATE OR REPLACE FUNCTION fake_liker_run_totals()
 RETURNS TABLE(total_likes_sent bigint, total_matches_created bigint, total_salams_sent bigint, last_run_at timestamp with time zone)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    COALESCE(SUM(likes_sent), 0),
    COALESCE(SUM(matches_created), 0),
    COALESCE(SUM(salams_sent), 0),
    MAX(started_at)
  FROM fake_liker_runs
$function$;

CREATE VIEW pending_report_summary AS
 SELECT reported_id,
    count(*) AS report_count,
    array_agg(DISTINCT reason) AS reasons,
    array_agg(DISTINCT context) AS contexts,
    max(created_at) AS latest_at
   FROM reports
  WHERE status = 'pending'::report_status
  GROUP BY reported_id;

CREATE VIEW photo_ai_check_stats AS
 SELECT count(*) AS total,
    count(*) FILTER (WHERE approved) AS approved,
    count(*) FILTER (WHERE NOT approved) AS rejected,
    count(*) FILTER (WHERE created_at > (now() - '24:00:00'::interval)) AS total_24h,
    count(*) FILTER (WHERE NOT approved AND created_at > (now() - '24:00:00'::interval)) AS rejected_24h,
    count(*) FILTER (WHERE created_at > (now() - '7 days'::interval)) AS total_7d,
    count(*) FILTER (WHERE NOT approved AND created_at > (now() - '7 days'::interval)) AS rejected_7d,
    COALESCE(sum(prompt_tokens), 0::bigint) AS prompt_tokens,
    COALESCE(sum(completion_tokens), 0::bigint) AS completion_tokens,
    COALESCE(( SELECT jsonb_object_agg(r.reason, r.n) AS jsonb_object_agg
           FROM ( SELECT photo_ai_checks_1.reason,
                    count(*) AS n
                   FROM photo_ai_checks photo_ai_checks_1
                  WHERE NOT photo_ai_checks_1.approved AND photo_ai_checks_1.reason IS NOT NULL
                  GROUP BY photo_ai_checks_1.reason) r), '{}'::jsonb) AS by_reason
   FROM photo_ai_checks;

CREATE TRIGGER trg_bump_match_last_message_at AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION bump_match_last_message_at();

-- ── Singleton config rows (fresh installs; real data overwrites on import) ──

INSERT INTO fake_liker_config (id) VALUES (true);
INSERT INTO gift_config (id) VALUES (true);
INSERT INTO moderation_config (id) VALUES (true);
INSERT INTO premium_config (id) VALUES (true);
INSERT INTO purchase_message_config (id) VALUES (true);
INSERT INTO referral_config (id) VALUES (true);
