-- ============================================================
-- Migration 034 — Hesap bazlı başarısız giriş kilidi
-- ============================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

COMMENT ON COLUMN users.failed_login_count IS
  'Ardışık başarısız giriş sayısı; başarılı girişte sıfırlanır';
COMMENT ON COLUMN users.locked_until IS
  'Bu zamana kadar giriş reddedilir (brute-force koruması)';

CREATE INDEX IF NOT EXISTS idx_users_locked_until
  ON users (locked_until)
  WHERE locked_until IS NOT NULL;

COMMIT;
