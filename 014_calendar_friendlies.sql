-- ============================================================
-- 014: Lig takvim slotları + dostluk maçları
-- ============================================================

BEGIN;

-- Örnek varsayılan slotlar (TR): Cmt/Paz 15:00 ve 18:00
INSERT INTO game_settings (key, value) VALUES
  (
    'league_match_slots',
    '[{"dow":6,"hour":15,"minute":0},{"dow":6,"hour":18,"minute":0},{"dow":0,"hour":15,"minute":0},{"dow":0,"hour":18,"minute":0}]'
  ),
  ('fixture_interval_hours', '0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
WHERE game_settings.key = 'league_match_slots'
   OR (game_settings.key = 'fixture_interval_hours' AND game_settings.value = '3');

-- Dostluk maçları
CREATE TABLE IF NOT EXISTS friendly_fixtures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  home_club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  away_club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kickoff_at      TIMESTAMPTZ NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',
  -- pending | scheduled | live | finished | cancelled | declined
  home_goals      SMALLINT,
  away_goals      SMALLINT,
  match_id        TEXT,
  proposed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_friendly_clubs CHECK (home_club_id <> away_club_id)
);

CREATE INDEX IF NOT EXISTS idx_friendly_kickoff
  ON friendly_fixtures (status, kickoff_at);

CREATE INDEX IF NOT EXISTS idx_friendly_clubs
  ON friendly_fixtures (home_club_id, away_club_id);

COMMIT;
