-- Elite özellik depolama (forma, 2. takım, günlük ödül)
ALTER TABLE clubs
  ADD COLUMN IF NOT EXISTS kit_design JSONB,
  ADD COLUMN IF NOT EXISTS second_team JSONB;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_reward_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS daily_reward_streak INTEGER NOT NULL DEFAULT 0;
