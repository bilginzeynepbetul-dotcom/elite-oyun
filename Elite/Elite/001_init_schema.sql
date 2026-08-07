-- ============================================================
-- Elite Manager Online — Migration 001: initial schema
-- PostgreSQL 14+
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- 1. Users
-- ------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(32) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email         VARCHAR(255),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  is_banned     BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_users_username UNIQUE (username),
  CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE INDEX idx_users_username_lower ON users (LOWER(username));

-- ------------------------------------------------------------
-- 2. Clubs & economy
-- ------------------------------------------------------------
CREATE TABLE clubs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(64) NOT NULL,
  country       VARCHAR(48) NOT NULL DEFAULT 'Türkiye',
  division      SMALLINT NOT NULL DEFAULT 1,
  balance       BIGINT NOT NULL DEFAULT 5000000,
  game_style    VARCHAR(16) NOT NULL DEFAULT 'dengeli',
  pass_style    VARCHAR(16) NOT NULL DEFAULT 'kısa',
  attack_dir    VARCHAR(16) NOT NULL DEFAULT 'orta',
  formation     VARCHAR(16) NOT NULL DEFAULT '4-4-2',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_clubs_user UNIQUE (user_id)
);

CREATE INDEX idx_clubs_country_division ON clubs (country, division);

CREATE TABLE finance_ledger (
  id         BIGSERIAL PRIMARY KEY,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  amount     BIGINT NOT NULL,
  label      VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_club_ts ON finance_ledger (club_id, created_at DESC);

-- ------------------------------------------------------------
-- 3. Players
-- ------------------------------------------------------------
CREATE TABLE players (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id         UUID REFERENCES clubs(id) ON DELETE SET NULL,
  name            VARCHAR(64) NOT NULL,
  number          SMALLINT,
  pos             VARCHAR(8) NOT NULL,
  natural_pos     VARCHAR(8),
  age             SMALLINT NOT NULL DEFAULT 18,
  pace            REAL NOT NULL DEFAULT 10,
  passing         REAL NOT NULL DEFAULT 10,
  finishing       REAL NOT NULL DEFAULT 10,
  tackle          REAL NOT NULL DEFAULT 10,
  vision          REAL NOT NULL DEFAULT 10,
  stamina         REAL NOT NULL DEFAULT 10,
  strength        REAL NOT NULL DEFAULT 10,
  technique       REAL NOT NULL DEFAULT 10,
  agility         REAL NOT NULL DEFAULT 10,
  positioning     REAL NOT NULL DEFAULT 10,
  reflex          REAL NOT NULL DEFAULT 10,
  handling        REAL NOT NULL DEFAULT 10,
  condition       REAL NOT NULL DEFAULT 90,
  form            REAL NOT NULL DEFAULT 0,
  experience      REAL NOT NULL DEFAULT 3,
  happiness       REAL NOT NULL DEFAULT 80,
  base_quality    SMALLINT,
  base_potential  SMALLINT,
  from_academy    BOOLEAN NOT NULL DEFAULT FALSE,
  from_market     BOOLEAN NOT NULL DEFAULT FALSE,
  is_starter      BOOLEAN NOT NULL DEFAULT FALSE,
  bench_order     SMALLINT,
  injured         BOOLEAN NOT NULL DEFAULT FALSE,
  sent_off        BOOLEAN NOT NULL DEFAULT FALSE,
  cards           SMALLINT NOT NULL DEFAULT 0,
  goals           INT NOT NULL DEFAULT 0,
  assists         INT NOT NULL DEFAULT 0,
  minutes_played  INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_players_club ON players (club_id);
CREATE INDEX idx_players_club_starter ON players (club_id, is_starter);

-- ------------------------------------------------------------
-- 4. Seasons, standings, fixtures
-- ------------------------------------------------------------
CREATE TABLE seasons (
  id         SERIAL PRIMARY KEY,
  country    VARCHAR(48) NOT NULL,
  division   SMALLINT NOT NULL,
  year_label VARCHAR(16) NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_seasons_cdy UNIQUE (country, division, year_label)
);

CREATE TABLE league_standings (
  id         BIGSERIAL PRIMARY KEY,
  season_id  INT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  played     SMALLINT NOT NULL DEFAULT 0,
  won        SMALLINT NOT NULL DEFAULT 0,
  drawn      SMALLINT NOT NULL DEFAULT 0,
  lost       SMALLINT NOT NULL DEFAULT 0,
  gf         SMALLINT NOT NULL DEFAULT 0,
  ga         SMALLINT NOT NULL DEFAULT 0,
  pts        SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT uq_standings_season_club UNIQUE (season_id, club_id)
);

CREATE INDEX idx_standings_season_pts ON league_standings (season_id, pts DESC, gf DESC);

CREATE TYPE fixture_status AS ENUM ('scheduled', 'live', 'finished', 'cancelled');

CREATE TABLE fixtures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id     INT NOT NULL REFERENCES seasons(id),
  home_club_id  UUID NOT NULL REFERENCES clubs(id),
  away_club_id  UUID NOT NULL REFERENCES clubs(id),
  kickoff_at    TIMESTAMPTZ NOT NULL,
  status        fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals    SMALLINT,
  away_goals    SMALLINT,
  match_id      UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fixtures_different_clubs CHECK (home_club_id <> away_club_id)
);

CREATE INDEX idx_fixtures_kickoff ON fixtures (kickoff_at);
CREATE INDEX idx_fixtures_status ON fixtures (status);
CREATE INDEX idx_fixtures_home ON fixtures (home_club_id);
CREATE INDEX idx_fixtures_away ON fixtures (away_club_id);

-- ------------------------------------------------------------
-- 5. Match archive
-- ------------------------------------------------------------
CREATE TABLE match_results (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id   UUID UNIQUE REFERENCES fixtures(id) ON DELETE SET NULL,
  home_club_id UUID NOT NULL REFERENCES clubs(id),
  away_club_id UUID NOT NULL REFERENCES clubs(id),
  home_goals   SMALLINT NOT NULL,
  away_goals   SMALLINT NOT NULL,
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  scorers      JSONB NOT NULL DEFAULT '[]'::jsonb,
  finished_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE match_logs (
  id         BIGSERIAL PRIMARY KEY,
  match_id   UUID NOT NULL REFERENCES match_results(id) ON DELETE CASCADE,
  minute     SMALLINT,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_match_logs_match ON match_logs (match_id);

-- ------------------------------------------------------------
-- 6. Transfer market
-- ------------------------------------------------------------
CREATE TYPE listing_status AS ENUM ('active', 'sold', 'expired', 'cancelled');

CREATE TABLE transfer_listings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id               UUID REFERENCES players(id) ON DELETE SET NULL,
  seller_club_id          UUID REFERENCES clubs(id) ON DELETE SET NULL,
  club_name_snapshot      VARCHAR(64) NOT NULL,
  player_snapshot         JSONB NOT NULL,
  auction_start           BIGINT NOT NULL,
  current_bid             BIGINT NOT NULL,
  highest_bidder_club_id  UUID REFERENCES clubs(id) ON DELETE SET NULL,
  highest_bidder_name     VARCHAR(64),
  auction_ends_at         TIMESTAMPTZ NOT NULL,
  status                  listing_status NOT NULL DEFAULT 'active',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_listings_active_ends
  ON transfer_listings (auction_ends_at)
  WHERE status = 'active';

CREATE INDEX idx_listings_seller ON transfer_listings (seller_club_id);

CREATE TABLE transfer_bids (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  UUID NOT NULL REFERENCES transfer_listings(id) ON DELETE CASCADE,
  club_id     UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  club_name   VARCHAR(64) NOT NULL,
  amount      BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bids_listing ON transfer_bids (listing_id, created_at DESC);

-- ------------------------------------------------------------
-- 7. Youth academy
-- ------------------------------------------------------------
CREATE TABLE youth_academy (
  club_id               UUID PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  scout_level           SMALLINT NOT NULL DEFAULT 1
                          CHECK (scout_level BETWEEN 1 AND 5),
  academy_level         SMALLINT NOT NULL DEFAULT 1
                          CHECK (academy_level BETWEEN 1 AND 5),
  draws_this_season     SMALLINT NOT NULL DEFAULT 0,
  max_draws_per_season  SMALLINT NOT NULL DEFAULT 12,
  last_draw_week_key    VARCHAR(16),
  scout_upgrade_until   TIMESTAMPTZ,
  academy_upgrade_until TIMESTAMPTZ,
  pending_scout_level   SMALLINT,
  pending_academy_level SMALLINT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE youth_discoveries (
  id         BIGSERIAL PRIMARY KEY,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id  UUID REFERENCES players(id) ON DELETE SET NULL,
  name       VARCHAR(64) NOT NULL,
  pos        VARCHAR(8),
  age        SMALLINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_youth_disc_club ON youth_discoveries (club_id, created_at DESC);

-- ------------------------------------------------------------
-- 8. Training & coaches
-- ------------------------------------------------------------
CREATE TABLE club_coaches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  skill      VARCHAR(16) NOT NULL,
  level      SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 5),
  salary     INT NOT NULL DEFAULT 0,
  name       VARCHAR(64),
  CONSTRAINT uq_coaches_club_skill UNIQUE (club_id, skill)
);

CREATE TABLE training_log (
  id          BIGSERIAL PRIMARY KEY,
  club_id     UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id   UUID REFERENCES players(id) ON DELETE SET NULL,
  player_name VARCHAR(64),
  skill       VARCHAR(16) NOT NULL,
  delta       REAL NOT NULL,
  value_after REAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_training_club_ts ON training_log (club_id, created_at DESC);

-- ------------------------------------------------------------
-- 9. Stadium
-- ------------------------------------------------------------
CREATE TABLE stadiums (
  club_id           UUID PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
  name              VARCHAR(64) NOT NULL,
  capacity          INT NOT NULL DEFAULT 24500
                      CHECK (capacity BETWEEN 1000 AND 120000),
  ticket_price      SMALLINT NOT NULL DEFAULT 12
                      CHECK (ticket_price BETWEEN 5 AND 80),
  seat_upgrade_cost INT NOT NULL DEFAULT 45000,
  total_upgrades    INT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 10. Social: forum, messages, notifications
-- ------------------------------------------------------------
CREATE TABLE forum_posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  username   VARCHAR(32) NOT NULL,
  text       VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_forum_ts ON forum_posts (created_at DESC);

CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         VARCHAR(200) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_messages_not_self CHECK (from_user_id <> to_user_id)
);

CREATE INDEX idx_messages_to_ts ON messages (to_user_id, created_at DESC);
CREATE INDEX idx_messages_from_ts ON messages (from_user_id, created_at DESC);

CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  icon       VARCHAR(8) NOT NULL DEFAULT '🔔',
  text       VARCHAR(200) NOT NULL,
  category   VARCHAR(32),
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifs_user_unread ON notifications (user_id, is_read, created_at DESC);

-- ------------------------------------------------------------
-- 11. updated_at trigger helper
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_clubs_updated
  BEFORE UPDATE ON clubs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_players_updated
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_youth_updated
  BEFORE UPDATE ON youth_academy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_stadiums_updated
  BEFORE UPDATE ON stadiums
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- 12. Seed: current season (Türkiye div 1) + forum welcome
-- ------------------------------------------------------------
INSERT INTO seasons (country, division, year_label, is_current)
VALUES ('Türkiye', 1, '2025/26', TRUE);

INSERT INTO forum_posts (user_id, username, text, created_at) VALUES
  (NULL, 'Admin',
   'Hoş geldiniz! Transfer, stadyum ve altyapı güncellemeleri aktif.',
   NOW() - INTERVAL '1 hour'),
  (NULL, 'ScoutTR',
   'Altyapıdan genç çekmek uzun vadede kazandırıyor.',
   NOW() - INTERVAL '1 day');

COMMIT;
