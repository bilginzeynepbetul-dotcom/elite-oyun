-- ============================================================
-- Migration 024: Kulüp doktoru + sakatlık günü
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS club_doctors (
  id         BIGSERIAL PRIMARY KEY,
  club_id    UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name       VARCHAR(64) NOT NULL DEFAULT 'Dr. Yılmaz',
  spec       VARCHAR(24) NOT NULL DEFAULT 'genel',
  level      SMALLINT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  salary     INT NOT NULL DEFAULT 3000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_club_doctors_one UNIQUE (club_id)
);

CREATE INDEX IF NOT EXISTS idx_club_doctors_club ON club_doctors (club_id);

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS injury_days_left SMALLINT NOT NULL DEFAULT 0;

COMMIT;
