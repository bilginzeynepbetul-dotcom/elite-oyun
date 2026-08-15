-- ============================================================
-- Elite Manager Online — Migration 010: Oyuncu sözleşmesi + maaş
-- ============================================================

BEGIN;

-- Haftalık brüt maaş (€). 0 = henüz set edilmemiş (sistem tahmin eder).
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS wage INT NOT NULL DEFAULT 0;

-- Sözleşme bitiş tarihi (UTC). NULL = süresiz / henüz set yok.
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS contract_ends_at TIMESTAMPTZ;

-- Son maaş ödemesi (oyuncu bazında; bordro tick'inde güncellenir)
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS last_wage_paid_at TIMESTAMPTZ;

-- Kulüp: son bordro çalıştırma zamanı (çift ödemeyi önler)
ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS last_payroll_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_players_contract_ends
  ON players (contract_ends_at)
  WHERE club_id IS NOT NULL AND contract_ends_at IS NOT NULL;

-- Mevcut oyunculara makul varsayılan maaş + 2 yıllık sözleşme
UPDATE players SET
  wage = GREATEST(
    800,
    LEAST(
      45000,
      ROUND(
        1500
        + COALESCE(base_quality, 5) * 1200
        + COALESCE(base_potential, 5) * 400
        + GREATEST(0, 28 - COALESCE(age, 22)) * 200
      )::INT
    )
  ),
  contract_ends_at = COALESCE(
    contract_ends_at,
    NOW() + INTERVAL '2 years'
  )
WHERE wage = 0 OR contract_ends_at IS NULL;

COMMIT;
