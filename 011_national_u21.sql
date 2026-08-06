-- ============================================================
-- Elite Manager Online — Migration 011: U21 Milli Takım
-- category: 'A' | 'U21'  — ülke başına iki milli takım
-- ============================================================

BEGIN;

ALTER TABLE national_teams
  ADD COLUMN IF NOT EXISTS category VARCHAR(8) NOT NULL DEFAULT 'A';

-- Eski UNIQUE(country) varsa kaldır, (country, category) yap
ALTER TABLE national_teams DROP CONSTRAINT IF EXISTS national_teams_country_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_national_teams_country_cat'
  ) THEN
    ALTER TABLE national_teams
      ADD CONSTRAINT uq_national_teams_country_cat UNIQUE (country, category);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_national_teams_cat
  ON national_teams (country, category);

-- Mevcut satırlar A kalsın; U21 satırını ekle
UPDATE national_teams SET category = 'A' WHERE category IS NULL OR category = '';

INSERT INTO national_teams (country, category)
VALUES ('Türkiye', 'U21')
ON CONFLICT (country, category) DO NOTHING;

COMMIT;
