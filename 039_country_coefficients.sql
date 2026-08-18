-- ============================================================
-- Migration 039: Ülke katsayısı (Kıtasal Lig + Elite Kupa torbası)
-- 2. sezon kupa sonuçlarından puan → 3. sezondan kontenjan
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS country_coefficients (
  id           BIGSERIAL PRIMARY KEY,
  country      VARCHAR(48) NOT NULL,
  season_label VARCHAR(24) NOT NULL,
  -- Bu dönemden kazanılan puan
  points       NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Kıtasal Lig / Elite maç özeti
  kl_played    SMALLINT NOT NULL DEFAULT 0,
  kl_wins      SMALLINT NOT NULL DEFAULT 0,
  ek_played    SMALLINT NOT NULL DEFAULT 0,
  ek_wins      SMALLINT NOT NULL DEFAULT 0,
  -- Son durum: kl_champion | kl_finalist | ek_champion | ...
  best_finish  VARCHAR(32),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (country, season_label)
);

CREATE INDEX IF NOT EXISTS idx_country_coeff_season
  ON country_coefficients (season_label, points DESC);

CREATE INDEX IF NOT EXISTS idx_country_coeff_country
  ON country_coefficients (country);

-- Anlık toplam (rolling) — UI torba listesi
CREATE TABLE IF NOT EXISTS country_coefficient_totals (
  country      VARCHAR(48) PRIMARY KEY,
  total_points NUMERIC(12, 2) NOT NULL DEFAULT 0,
  rank         INT,
  -- Kontenjan: kitasal_slots + elite_slots
  kitasal_slots SMALLINT NOT NULL DEFAULT 0,
  elite_slots   SMALLINT NOT NULL DEFAULT 1,
  total_slots   SMALLINT NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
