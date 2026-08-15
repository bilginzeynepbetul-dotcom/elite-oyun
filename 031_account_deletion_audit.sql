-- ============================================================
-- Migration 031 — Hesap kapatma denetim kaydı
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS account_deletion_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL,
  anonymized_username VARCHAR(48) NOT NULL,
  club_ids        UUID[] NOT NULL DEFAULT '{}',
  requested_by    UUID,
  reason          TEXT NOT NULL DEFAULT 'user_request',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_log_user
  ON account_deletion_log (user_id);
CREATE INDEX IF NOT EXISTS idx_account_deletion_log_ts
  ON account_deletion_log (created_at DESC);

COMMENT ON TABLE account_deletion_log IS
  'Hesap kapatma denetim kaydı (KVKK soft-delete). PII tutmaz.';

COMMIT;
