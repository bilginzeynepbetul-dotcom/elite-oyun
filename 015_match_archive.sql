-- ============================================================
-- 015: Maç arşivi genişletme (kupa / milli / dostluk + loglar)
-- ============================================================

BEGIN;

-- competition: league | cup | national | friendly | continental
ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS competition VARCHAR(24) NOT NULL DEFAULT 'league';

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS home_name VARCHAR(64);

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS away_name VARCHAR(64);

ALTER TABLE match_results
  ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Aynı fixture_id için tek satır; external_id ile de aranabilir
CREATE INDEX IF NOT EXISTS idx_match_results_ext
  ON match_results (competition, external_id);

CREATE INDEX IF NOT EXISTS idx_match_results_finished
  ON match_results (finished_at DESC);

-- Log satırlarına olay tipi (goal, card, injury, system, ...)
ALTER TABLE match_logs
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(24) DEFAULT 'log';

ALTER TABLE match_logs
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
