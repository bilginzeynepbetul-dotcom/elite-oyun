-- Yabancı altyapı şubeleri
-- clubs.id UUID → club_id UUID (TEXT FK "cannot be implemented" hatasını önler)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'youth_branches'
  ) THEN
    -- Yanlış tipte (TEXT) oluşturulmuşsa kaldır
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'youth_branches'
        AND column_name = 'club_id' AND data_type = 'text'
    ) THEN
      DROP TABLE youth_branches;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS youth_branches (
  id SERIAL PRIMARY KEY,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  build_cost INTEGER NOT NULL DEFAULT 0,
  UNIQUE (club_id, country)
);

CREATE INDEX IF NOT EXISTS idx_youth_branches_club ON youth_branches(club_id);
