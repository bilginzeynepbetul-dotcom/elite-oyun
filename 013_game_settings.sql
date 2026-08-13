-- ============================================================
-- Migration 013: oyun ayarları (sezon başlangıcı vb.)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS game_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Varsayılan: sezon 10 Ağustos 2026 15:00 Türkiye saati (UTC+3)
INSERT INTO game_settings (key, value) VALUES
  ('season_start_at', '2026-08-10T15:00:00+03:00'),
  ('fixture_interval_hours', '3')
ON CONFLICT (key) DO NOTHING;

COMMIT;
