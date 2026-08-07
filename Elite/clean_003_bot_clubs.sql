-- ============================================================
-- Migration 003: bot clubs support
-- clubs.user_id nullable + is_bot flag
-- ============================================================


ALTER TABLE clubs
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE clubs
  DROP CONSTRAINT IF EXISTS uq_clubs_user;

-- Human clubs: still one club per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_clubs_user_human
  ON clubs (user_id)
  WHERE user_id IS NOT NULL;

ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_clubs_is_bot ON clubs (is_bot);
CREATE INDEX IF NOT EXISTS idx_clubs_country_div_bot ON clubs (country, division, is_bot);

