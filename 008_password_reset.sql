-- ============================================================
-- Elite Manager Online — Migration 008
-- Şifremi unuttum: güvenlik sorusu + cevabı (hash'li)
-- ============================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS security_question TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_answer_hash TEXT;

COMMIT;
