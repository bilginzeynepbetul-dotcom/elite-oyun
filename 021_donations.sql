-- Bağış / Destek Ol kayıtları
CREATE TABLE IF NOT EXISTS donations (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'try',
  method          TEXT NOT NULL DEFAULT 'iban',
  reference_code  TEXT,
  note            TEXT,
  payer_name      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  admin_note      TEXT,
  reviewed_by     UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_donations_user ON donations(user_id);
CREATE INDEX IF NOT EXISTS idx_donations_status ON donations(status);
CREATE INDEX IF NOT EXISTS idx_donations_created ON donations(created_at DESC);
