-- ============================================================
-- Migration 027 — token_version (JWT iptali / şifre değişince oturum düşür)
-- Access + refresh token payload'da "tv" alanı ile kontrol edilir.
-- Şifre sıfırlama, ban, logout-all → token_version artar → eski tokenlar geçersiz.
-- ============================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN users.token_version IS
  'JWT iptal sayacı; artınca mevcut access/refresh tokenlar reddedilir';

COMMIT;
