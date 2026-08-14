-- 026: Günlük görevler
CREATE TABLE IF NOT EXISTS daily_challenge_progress (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_key     TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  challenge_id TEXT NOT NULL,
  progress    INTEGER NOT NULL DEFAULT 0,
  target      INTEGER NOT NULL DEFAULT 1,
  completed   BOOLEAN NOT NULL DEFAULT FALSE,
  claimed     BOOLEAN NOT NULL DEFAULT FALSE,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day_key, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_user_day
  ON daily_challenge_progress (user_id, day_key);
