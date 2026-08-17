-- Yabancı altyapı şubeleri
CREATE TABLE IF NOT EXISTS youth_branches (
  id SERIAL PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  build_cost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (club_id, country)
);
CREATE INDEX IF NOT EXISTS idx_youth_branches_club ON youth_branches(club_id);
