-- Manuel çalıştır: Render Postgres shell veya psql ile
-- national/state 500 için eksik tablo/kolonları tamamlar

BEGIN;

-- 007: TD başvuruları
CREATE TABLE IF NOT EXISTS national_manager_applications (
  id                BIGSERIAL PRIMARY KEY,
  national_team_id  INT NOT NULL REFERENCES national_teams(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id           UUID REFERENCES clubs(id) ON DELETE SET NULL,
  message           TEXT,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nat_app_pending
  ON national_manager_applications (national_team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_nat_app_team_status
  ON national_manager_applications (national_team_id, status);

-- 011: category kolonu
ALTER TABLE national_teams
  ADD COLUMN IF NOT EXISTS category VARCHAR(8) NOT NULL DEFAULT 'A';

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

UPDATE national_teams SET category = 'A' WHERE category IS NULL OR category = '';

INSERT INTO national_teams (country, category)
VALUES ('Türkiye', 'A')
ON CONFLICT DO NOTHING;

INSERT INTO national_teams (country, category)
VALUES ('Türkiye', 'U21')
ON CONFLICT DO NOTHING;

-- 009: pass_style
ALTER TABLE national_teams ADD COLUMN IF NOT EXISTS pass_style VARCHAR(16) NOT NULL DEFAULT 'kisa';
ALTER TABLE national_squad ADD COLUMN IF NOT EXISTS pos TEXT;

-- schema_migrations işaretle (varsa)
INSERT INTO schema_migrations (filename) VALUES ('007_national_manager_applications.sql') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (filename) VALUES ('009_national_tactics.sql') ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (filename) VALUES ('011_national_u21.sql') ON CONFLICT DO NOTHING;

COMMIT;
