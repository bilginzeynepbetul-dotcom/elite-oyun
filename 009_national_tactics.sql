-- ============================================================
-- Elite Manager Online — Migration 009
-- Milli takım taktik sayfası: ilk 11 mevki ataması + pas stili
-- ============================================================

BEGIN;

ALTER TABLE national_squad ADD COLUMN IF NOT EXISTS pos TEXT;
ALTER TABLE national_teams ADD COLUMN IF NOT EXISTS pass_style VARCHAR(16) NOT NULL DEFAULT 'kisa';

COMMIT;
