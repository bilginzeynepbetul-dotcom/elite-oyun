-- Ban süre + sebep (is_banned zaten var)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ban_reason TEXT,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_by INTEGER;

-- anti_cheat_log yoksa (018 ile gelmiş olmalı)
CREATE TABLE IF NOT EXISTS anti_cheat_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER,
  club_id    INTEGER,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_user ON anti_cheat_log(user_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_created ON anti_cheat_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_is_banned ON users(is_banned) WHERE is_banned = TRUE;
