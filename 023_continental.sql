-- ============================================================
-- Elite Manager Online — Migration 023: Kıtalar Ligi (Continental)
-- Idempotent: type / table zaten varsa hata vermez.
-- ============================================================

BEGIN;

-- Fixture status enum (scheduled | live | finished)
DO $$
BEGIN
  CREATE TYPE cl_fixture_status AS ENUM ('scheduled', 'live', 'finished');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS continental_editions (
  id                SERIAL PRIMARY KEY,
  year_label        VARCHAR(32) NOT NULL,
  is_current        BOOLEAN NOT NULL DEFAULT FALSE,
  phase             VARCHAR(16) NOT NULL DEFAULT 'group',
  -- group | knockout | sf | final | finished
  champion_club_id  UUID REFERENCES clubs(id) ON DELETE SET NULL,
  champion_name     VARCHAR(64),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cl_editions_current
  ON continental_editions (is_current) WHERE is_current = TRUE;

CREATE TABLE IF NOT EXISTS continental_entries (
  id           BIGSERIAL PRIMARY KEY,
  edition_id   INT NOT NULL REFERENCES continental_editions(id) ON DELETE CASCADE,
  club_id      UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  club_name    VARCHAR(64) NOT NULL,
  country      VARCHAR(48) NOT NULL DEFAULT '',
  grp          VARCHAR(4) NOT NULL,  -- A / B / C / D
  played       SMALLINT NOT NULL DEFAULT 0,
  won          SMALLINT NOT NULL DEFAULT 0,
  drawn        SMALLINT NOT NULL DEFAULT 0,
  lost         SMALLINT NOT NULL DEFAULT 0,
  gf           SMALLINT NOT NULL DEFAULT 0,
  ga           SMALLINT NOT NULL DEFAULT 0,
  pts          SMALLINT NOT NULL DEFAULT 0,
  CONSTRAINT uq_cl_entry UNIQUE (edition_id, club_id)
);

CREATE INDEX IF NOT EXISTS idx_cl_entries_edition_grp
  ON continental_entries (edition_id, grp);

CREATE TABLE IF NOT EXISTS continental_fixtures (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id       INT NOT NULL REFERENCES continental_editions(id) ON DELETE CASCADE,
  phase            VARCHAR(16) NOT NULL DEFAULT 'group',
  round_label      VARCHAR(32),
  grp              VARCHAR(4),
  slot             INT NOT NULL DEFAULT 0,
  home_club_id     UUID REFERENCES clubs(id) ON DELETE SET NULL,
  away_club_id     UUID REFERENCES clubs(id) ON DELETE SET NULL,
  kickoff_at       TIMESTAMPTZ NOT NULL,
  status           cl_fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals       SMALLINT,
  away_goals       SMALLINT,
  winner_club_id   UUID REFERENCES clubs(id) ON DELETE SET NULL,
  match_id         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cl_fixtures_edition
  ON continental_fixtures (edition_id, phase, slot);

CREATE INDEX IF NOT EXISTS idx_cl_fixtures_status_kickoff
  ON continental_fixtures (status, kickoff_at)
  WHERE status = 'scheduled';

COMMIT;
