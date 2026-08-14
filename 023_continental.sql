-- ============================================================
-- Migration 023: Kıtalar Ligi (Continental League)
-- Grup + eleme
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS continental_editions (
  id               SERIAL PRIMARY KEY,
  year_label       VARCHAR(16) NOT NULL,
  is_current       BOOLEAN NOT NULL DEFAULT TRUE,
  phase            VARCHAR(16) NOT NULL DEFAULT 'group',
  -- group | knockout | finished
  champion_club_id UUID REFERENCES clubs(id),
  champion_name    VARCHAR(64),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cl_editions_year UNIQUE (year_label)
);

CREATE INDEX IF NOT EXISTS idx_cl_editions_current
  ON continental_editions (is_current);

CREATE TABLE IF NOT EXISTS continental_entries (
  id          BIGSERIAL PRIMARY KEY,
  edition_id  INT NOT NULL REFERENCES continental_editions(id) ON DELETE CASCADE,
  club_id     UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  club_name   VARCHAR(64) NOT NULL,
  country     VARCHAR(48) NOT NULL,
  grp         CHAR(1) NOT NULL DEFAULT 'A',
  played      SMALLINT NOT NULL DEFAULT 0,
  won         SMALLINT NOT NULL DEFAULT 0,
  drawn       SMALLINT NOT NULL DEFAULT 0,
  lost        SMALLINT NOT NULL DEFAULT 0,
  gf          SMALLINT NOT NULL DEFAULT 0,
  ga          SMALLINT NOT NULL DEFAULT 0,
  pts         SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (edition_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_cl_entries_edition_grp
  ON continental_entries (edition_id, grp, pts DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cl_fixture_status') THEN
    CREATE TYPE cl_fixture_status AS ENUM ('scheduled', 'live', 'finished', 'cancelled');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS continental_fixtures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     INT NOT NULL REFERENCES continental_editions(id) ON DELETE CASCADE,
  phase          VARCHAR(16) NOT NULL DEFAULT 'group',
  -- group | sf | final
  round_label    VARCHAR(32) NOT NULL DEFAULT 'Grup',
  grp            CHAR(1),
  slot           SMALLINT NOT NULL DEFAULT 0,
  home_club_id   UUID REFERENCES clubs(id),
  away_club_id   UUID REFERENCES clubs(id),
  kickoff_at     TIMESTAMPTZ,
  status         cl_fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals     SMALLINT,
  away_goals     SMALLINT,
  match_id       TEXT,
  winner_club_id UUID REFERENCES clubs(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cl_fixtures_edition
  ON continental_fixtures (edition_id, phase, slot);
CREATE INDEX IF NOT EXISTS idx_cl_fixtures_kickoff
  ON continental_fixtures (kickoff_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_cl_fixtures_home ON continental_fixtures (home_club_id);
CREATE INDEX IF NOT EXISTS idx_cl_fixtures_away ON continental_fixtures (away_club_id);

COMMIT;
