-- Elite üyelik / abonelik
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS elite_plan TEXT,
  ADD COLUMN IF NOT EXISTS elite_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS elite_trial_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS elite_provider TEXT,
  ADD COLUMN IF NOT EXISTS elite_provider_ref TEXT;

CREATE TABLE IF NOT EXISTS elite_payments (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan          TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'try',
  provider      TEXT NOT NULL DEFAULT 'mock',
  provider_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_elite_payments_user ON elite_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_users_elite_until ON users(elite_until);
