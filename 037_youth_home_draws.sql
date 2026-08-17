-- Yerel zorunlu çekim sayacı
ALTER TABLE youth_academy
  ADD COLUMN IF NOT EXISTS home_draws_this_season SMALLINT NOT NULL DEFAULT 0;
