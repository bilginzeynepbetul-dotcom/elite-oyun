-- ============================================================
-- Migration 038: Elite Kupa
-- 1. Lig 2. ve 3.'leri — küresel tek maçlı eleme (128 takım)
-- Kıtasal Lig (1.'ler) ile birlikte 2. sezonda açılır.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'elite_cup_fixture_status') THEN
    CREATE TYPE elite_cup_fixture_status AS ENUM ('scheduled', 'live', 'finished', 'bye');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS elite_cup_editions (
  id               SERIAL PRIMARY KEY,
  year_label       VARCHAR(16) NOT NULL,
  is_current       BOOLEAN NOT NULL DEFAULT TRUE,
  current_round    SMALLINT NOT NULL DEFAULT 1,
  total_rounds     SMALLINT NOT NULL DEFAULT 7,
  champion_club_id UUID REFERENCES clubs(id),
  champion_name    VARCHAR(64),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_elite_cup_editions_year UNIQUE (year_label)
);

CREATE INDEX IF NOT EXISTS idx_elite_cup_editions_current
  ON elite_cup_editions (is_current);

CREATE TABLE IF NOT EXISTS elite_cup_fixtures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     INT NOT NULL REFERENCES elite_cup_editions(id) ON DELETE CASCADE,
  round          SMALLINT NOT NULL,
  round_label    VARCHAR(32) NOT NULL,
  slot           SMALLINT NOT NULL DEFAULT 0,
  home_club_id   UUID REFERENCES clubs(id),
  away_club_id   UUID REFERENCES clubs(id),
  kickoff_at     TIMESTAMPTZ,
  status         elite_cup_fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals     SMALLINT,
  away_goals     SMALLINT,
  penalties      BOOLEAN NOT NULL DEFAULT FALSE,
  match_id       TEXT,
  winner_club_id UUID REFERENCES clubs(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_elite_cup_fixtures_edition_round
  ON elite_cup_fixtures (edition_id, round);
CREATE INDEX IF NOT EXISTS idx_elite_cup_fixtures_kickoff
  ON elite_cup_fixtures (kickoff_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_elite_cup_fixtures_home
  ON elite_cup_fixtures (home_club_id);
CREATE INDEX IF NOT EXISTS idx_elite_cup_fixtures_away
  ON elite_cup_fixtures (away_club_id);

COMMIT;
