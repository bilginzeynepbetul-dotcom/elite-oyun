-- ============================================================
-- Migration 030 — Hesap kapatma / soft-delete (KVKK & GDPR)
-- ------------------------------------------------------------
-- Maç / lig geçmişi (fixtures, match_results vb.) clubs(id) ile
-- RESTRICT bağlı olduğu için kullanıcı/kulüp satırını fiziksel
-- silmek mümkün değil. Bunun yerine:
--   • users.deleted_at işaretlenir
--   • PII anonimleştirilir (username, email, güvenlik sorusu, şifre)
--   • token_version artar → tüm oturumlar düşer
--   • kulüp user_id=NULL + is_bot=TRUE yapılır (lig geçmişi korunur)
-- Kullanıcı adı serbest kalır; aynı adla yeniden kayıt mümkün olur.
-- ============================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN users.deleted_at IS
  'Hesap kapatma zamanı (soft-delete). NULL = aktif hesap.';

CREATE INDEX IF NOT EXISTS idx_users_deleted_at
  ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Aktif kullanıcılar için e-posta benzersizliği (silinmiş hesaplar e-postayı serbest bırakır)
-- Not: uq_users_email bir UNIQUE CONSTRAINT'in index'i olabileceğinden, önce constraint
-- olarak düşürülmeli (bu index'i de otomatik siler); ardından düz bir index olarak
-- kalmış olma ihtimaline karşı DROP INDEX IF EXISTS ile güvence altına alınır.
ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_email;
DROP INDEX IF EXISTS uq_users_email;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_active
  ON users (LOWER(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;

COMMIT;
