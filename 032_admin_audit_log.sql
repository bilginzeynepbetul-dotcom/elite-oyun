-- ============================================================
-- Migration 032 — Admin denetim kaydı (ban / unban / bağış / hesap)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  admin_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  target_user_id UUID,
  target_label TEXT,
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin
  ON admin_audit_log (admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action
  ON admin_audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log (target_user_id, created_at DESC);

COMMENT ON TABLE admin_audit_log IS
  'Admin işlem denetimi: ban, unban, hesap kapatma, bağış onayı vb.';

COMMIT;
