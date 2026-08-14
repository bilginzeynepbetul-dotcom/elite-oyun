-- ============================================================
-- Elite Manager Online — Migration 007: TD başvuru/atama sistemi
-- ------------------------------------------------------------
-- Artık teknik direktörlük koltuğu "ilk tıklayan kapar" değil:
-- kullanıcılar başvurur, sadece admin (ADMIN_USERNAME) başvuranlar
-- arasından seçip atar.
-- Idempotent: tablo/index zaten varsa hata vermez.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS national_manager_applications (
  id                BIGSERIAL PRIMARY KEY,
  national_team_id  INT NOT NULL REFERENCES national_teams(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id           UUID REFERENCES clubs(id) ON DELETE SET NULL,
  message           TEXT,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | approved | rejected | withdrawn
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ
);

-- Aynı kullanıcının aynı takıma birden fazla BEKLEYEN başvurusu olamaz,
-- ama reddedilmiş/geri çekilmiş bir başvurudan sonra tekrar başvurabilir.
CREATE UNIQUE INDEX IF NOT EXISTS uq_nat_app_pending
  ON national_manager_applications (national_team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_nat_app_team_status
  ON national_manager_applications (national_team_id, status);

COMMIT;
