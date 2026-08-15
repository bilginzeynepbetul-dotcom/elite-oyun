-- ============================================================
-- Migration 012: Sezon istatistikleri + ödüller
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS player_season_stats (
  id          BIGSERIAL PRIMARY KEY,
  season_id   INT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  club_id     UUID REFERENCES clubs(id) ON DELETE SET NULL,
  player_name VARCHAR(64) NOT NULL,
  club_name   VARCHAR(64),
  goals       INT NOT NULL DEFAULT 0,
  assists     INT NOT NULL DEFAULT 0,
  matches     INT NOT NULL DEFAULT 0,
  motm        INT NOT NULL DEFAULT 0,
  UNIQUE (season_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_pss_season_goals
  ON player_season_stats (season_id, goals DESC, assists DESC);
CREATE INDEX IF NOT EXISTS idx_pss_season_assists
  ON player_season_stats (season_id, assists DESC, goals DESC);

CREATE TABLE IF NOT EXISTS player_month_stats (
  id          BIGSERIAL PRIMARY KEY,
  year        SMALLINT NOT NULL,
  month       SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  club_id     UUID REFERENCES clubs(id) ON DELETE SET NULL,
  player_name VARCHAR(64) NOT NULL,
  club_name   VARCHAR(64),
  goals       INT NOT NULL DEFAULT 0,
  assists     INT NOT NULL DEFAULT 0,
  matches     INT NOT NULL DEFAULT 0,
  UNIQUE (year, month, player_id)
);

CREATE INDEX IF NOT EXISTS idx_pms_ym_goals
  ON player_month_stats (year, month, goals DESC, assists DESC);

-- Aylık / yıllık ödül kayıtları (hesaplanınca yazılır)
CREATE TABLE IF NOT EXISTS season_awards (
  id            BIGSERIAL PRIMARY KEY,
  season_id     INT REFERENCES seasons(id) ON DELETE SET NULL,
  award_type    VARCHAR(32) NOT NULL,
  -- goal_king | assist_king | player_of_year | player_of_month
  year          SMALLINT,
  month         SMALLINT,
  player_id     UUID REFERENCES players(id) ON DELETE SET NULL,
  player_name   VARCHAR(64) NOT NULL,
  club_name     VARCHAR(64),
  value         INT NOT NULL DEFAULT 0,
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_awards_type
  ON season_awards (award_type, year DESC, month DESC);

COMMIT;
