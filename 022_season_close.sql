-- ============================================================
-- Migration 022: Sezon kapanışı + şampiyon kaydı
-- ============================================================

BEGIN;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS champion_club_id UUID REFERENCES clubs(id) ON DELETE SET NULL;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS champion_name VARCHAR(64);

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';
  -- active | finished

CREATE INDEX IF NOT EXISTS idx_seasons_country_div_finished
  ON seasons (country, division, finished_at DESC NULLS LAST);

-- Ödül: league_champion (kulüp bazlı, player_id null olabilir)
-- season_awards.player_name zaten NOT NULL — şampiyon kulüp adını yazarız

COMMIT;
