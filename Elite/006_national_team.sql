-- ============================================================
-- Elite Manager Online — Migration 006: Milli Takım
-- ------------------------------------------------------------
-- Ayrıca: fixtures.match_id ve cup_fixtures.match_id UUID kolonuydu
-- ama matchLifecycle.js/cupLifecycle.js "m_"/"cm_" önekli TEXT id
-- üretiyor (matchId = "m_" + fixtureId). Bu, maç saati geldiğinde
-- "invalid input syntax for type uuid" hatasıyla CANLI MAÇ
-- BAŞLATMAYI KIRIYORDU. TEXT'e çeviriyoruz (transfer_listings.id
-- için 004'te yapılan aynı düzeltme).
-- ============================================================

BEGIN;

ALTER TABLE fixtures ALTER COLUMN match_id TYPE TEXT USING match_id::text;
ALTER TABLE cup_fixtures ALTER COLUMN match_id TYPE TEXT USING match_id::text;

CREATE TABLE national_teams (
  id               SERIAL PRIMARY KEY,
  country          VARCHAR(48) NOT NULL UNIQUE,
  manager_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  manager_club_id  UUID REFERENCES clubs(id) ON DELETE SET NULL,
  manager_since    TIMESTAMPTZ,
  formation        VARCHAR(16) NOT NULL DEFAULT '4-4-2',
  game_style       VARCHAR(16) NOT NULL DEFAULT 'dengeli',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE national_squad (
  id                BIGSERIAL PRIMARY KEY,
  national_team_id  INT NOT NULL REFERENCES national_teams(id) ON DELETE CASCADE,
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  club_id           UUID REFERENCES clubs(id) ON DELETE SET NULL,
  is_starter        BOOLEAN NOT NULL DEFAULT FALSE,
  bench_order       SMALLINT,
  called_up_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_national_squad_player UNIQUE (national_team_id, player_id)
);

CREATE INDEX idx_national_squad_team ON national_squad (national_team_id);

CREATE TABLE national_fixtures (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  national_team_id   INT NOT NULL REFERENCES national_teams(id) ON DELETE CASCADE,
  opponent_name      VARCHAR(64) NOT NULL,
  opponent_strength  SMALLINT NOT NULL DEFAULT 60,
  kickoff_at         TIMESTAMPTZ NOT NULL,
  status             fixture_status NOT NULL DEFAULT 'scheduled',
  home_goals         SMALLINT,
  away_goals         SMALLINT,
  match_id           TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_national_fixtures_status ON national_fixtures (status);
CREATE INDEX idx_national_fixtures_team_kickoff ON national_fixtures (national_team_id, kickoff_at);

INSERT INTO national_teams (country) VALUES ('Türkiye')
  ON CONFLICT (country) DO NOTHING;

COMMIT;
