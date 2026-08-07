-- Anti-cheat audit log
CREATE TABLE IF NOT EXISTS anti_cheat_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  club_id    INTEGER,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_user ON anti_cheat_log(user_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_created ON anti_cheat_log(created_at DESC);
