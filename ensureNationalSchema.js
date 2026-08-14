// ============================================================
// ensureNationalSchema.js — milli takım tablolarını runtime'da tamamla
// Render DB shell olmadan da çalışır (DATABASE_URL yeterli).
// ============================================================

const { query } = require("./db");

let _done = false;
let _promise = null;

async function ensureNationalSchema() {
  if (_done) return { ok: true, skipped: true };
  if (_promise) return _promise;

  _promise = (async () => {
    try {
      // 007 — başvuru tablosu
      await query(`
        CREATE TABLE IF NOT EXISTS national_manager_applications (
          id                BIGSERIAL PRIMARY KEY,
          national_team_id  INT NOT NULL REFERENCES national_teams(id) ON DELETE CASCADE,
          user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          club_id           UUID REFERENCES clubs(id) ON DELETE SET NULL,
          message           TEXT,
          status            VARCHAR(16) NOT NULL DEFAULT 'pending',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at        TIMESTAMPTZ
        )
      `);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_nat_app_pending
          ON national_manager_applications (national_team_id, user_id)
          WHERE status = 'pending'
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_nat_app_team_status
          ON national_manager_applications (national_team_id, status)
      `);

      // 011 — category
      await query(`
        ALTER TABLE national_teams
          ADD COLUMN IF NOT EXISTS category VARCHAR(8) NOT NULL DEFAULT 'A'
      `);
      try {
        await query(
          `ALTER TABLE national_teams DROP CONSTRAINT IF EXISTS national_teams_country_key`,
        );
      } catch (_) {}
      await query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_national_teams_country_cat'
          ) THEN
            ALTER TABLE national_teams
              ADD CONSTRAINT uq_national_teams_country_cat UNIQUE (country, category);
          END IF;
        END $$
      `);
      await query(
        `UPDATE national_teams SET category = 'A' WHERE category IS NULL OR category = ''`,
      );
      try {
        await query(
          `INSERT INTO national_teams (country, category) VALUES ('Türkiye', 'A') ON CONFLICT DO NOTHING`,
        );
        await query(
          `INSERT INTO national_teams (country, category) VALUES ('Türkiye', 'U21') ON CONFLICT DO NOTHING`,
        );
      } catch (_) {}

      // 009 — pass_style + squad pos
      await query(
        `ALTER TABLE national_teams ADD COLUMN IF NOT EXISTS pass_style VARCHAR(16) NOT NULL DEFAULT 'kisa'`,
      );
      await query(
        `ALTER TABLE national_squad ADD COLUMN IF NOT EXISTS pos TEXT`,
      );

      // schema_migrations işaretle (tablo varsa)
      try {
        await query(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            filename TEXT NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        for (const f of [
          "007_national_manager_applications.sql",
          "009_national_tactics.sql",
          "011_national_u21.sql",
        ]) {
          await query(
            `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
            [f],
          );
        }
      } catch (_) {}

      _done = true;
      console.log("[ensureNationalSchema] ✓ milli takım şeması tamam");
      return { ok: true };
    } catch (e) {
      console.error(
        "[ensureNationalSchema] hata:",
        e && e.message ? e.message : e,
      );
      _promise = null;
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  })();

  return _promise;
}

module.exports = { ensureNationalSchema };
