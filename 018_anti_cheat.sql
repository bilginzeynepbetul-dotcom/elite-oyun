-- Anti-cheat log tablosu
CREATE TABLE IF NOT EXISTS anti_cheat_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  reason      TEXT,
  admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_user ON anti_cheat_log(user_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_admin ON anti_cheat_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_anti_cheat_log_created ON anti_cheat_log(created_at DESC);
