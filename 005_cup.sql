-- ============================================================
-- Elite Manager Online — Migration 005: Kupa (eleme usulü)
-- PostgreSQL 14+
-- ============================================================

BEGIN;

CREATE TYPE cup_fixture_status AS ENUM ('scheduled', 'live', 'finished', 'bye');

-- Ülke başına bir "kupa sezonu". Şampiyon belirlenince is_current=FALSE
-- olur, yeni edition açılabilir (POST /api/cup/generate).
CREATE TABLE cup_editions (
  id               SERIAL PRIMARY KEY,
  country          VARCHAR(48) NOT NULL,
  year_label       VARCHAR(16) NOT NULL,
  is_current       BOOLEAN NOT NULL DEFAULT TRUE,
  current_round    SMALLINT NOT NULL DEFAULT 1,
  total_rounds     SMALLINT NOT NULL,
  champion_club_id UUID REFERENCES clubs(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cup_editions UNIQUE (country, year_label)
);

CREATE INDEX idx_cup_editions_country_current
  ON cup_editions (country, is_current);

-- Tek eleme. home/away NULL ise bye (rakipsiz otomatik tur atlama) —
-- status='bye', winner_club_id dolu, kickoff_at/match_id NULL kalır.
CREATE TABLE cup_fixtures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     INT NOT NULL REFERENCES cup_editions(id) ON DELETE CASCADE,
  round          SMALLINT NOT NULL,
  round_label    VARCHAR(32) NOT NULL,
  slot           SMALLINT NOT NULL,
  home_club_id   UUID REFERENCES clubs(id),
  away_club_id   UUID REFERENCES clubs(id),
  kickoff_at     TIMESTAMPTZ,
  status         cup_fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals     SMALLINT,
  away_goals     SMALLINT,
  penalties      BOOLEAN NOT NULL DEFAULT FALSE,
  match_id       UUID,
  winner_club_id UUID REFERENCES clubs(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cup_fixtures_edition_round ON cup_fixtures (edition_id, round);
CREATE INDEX idx_cup_fixtures_kickoff
  ON cup_fixtures (kickoff_at) WHERE status = 'scheduled';
CREATE INDEX idx_cup_fixtures_home ON cup_fixtures (home_club_id);
CREATE INDEX idx_cup_fixtures_away ON cup_fixtures (away_club_id);

COMMIT;
