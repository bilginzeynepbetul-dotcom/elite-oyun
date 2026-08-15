-- ============================================================
-- Migration 033 — E-posta doğrulama
-- ============================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verify_token TEXT,
  ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_email_verify_token
  ON users (email_verify_token)
  WHERE email_verify_token IS NOT NULL;

COMMENT ON COLUMN users.email_verified_at IS
  'E-posta doğrulandığı an; NULL = doğrulanmamış veya e-posta yok';
COMMENT ON COLUMN users.email_verify_token IS
  'Tek kullanımlık doğrulama token (hash değil, kısa ömürlü)';

COMMIT;
