// ============================================================
// scripts/migrate.js — SQL migration runner
// ------------------------------------------------------------
//   node scripts/migrate.js
//   DATABASE_URL=... node scripts/migrate.js
// ============================================================

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool, query } = require("../db");

const ROOT = path.join(__dirname, "..");

const files = [
  "001_init_schema.sql",
  "002_register_club_fn.sql",
  "003_bot_clubs.sql",
  "004_transfer_id_text.sql",
  "005_cup.sql",
  "006_national_team.sql",
  "007_national_manager_applications.sql",
  "008_password_reset.sql",
  "009_national_tactics.sql",
  "010_player_contracts.sql",
  "011_national_u21.sql",
  "012_season_awards.sql",
  "013_game_settings.sql",
  "014_calendar_friendlies.sql",
  "015_match_archive.sql",
  "016_elite_subscriptions.sql",
  "017_elite_features.sql",
  "018_anti_cheat.sql",
  "019_ban_fields.sql",
  "020_register_club_country.sql",
  "021_donations.sql",
  "022_season_close.sql",
  "023_continental.sql",
  "024_club_doctors.sql",
  "025_achievements.sql",
  "026_daily_challenges.sql",
  "027_token_version.sql",
];

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Bazı ortamlarda schema_migrations tablosu daha önce farklı (bozuk) bir
  // yapıyla oluşturulmuş olabilir — örn. "filename" sütunu INTEGER tipinde.
  // CREATE TABLE IF NOT EXISTS bu durumda hiçbir şey yapmaz, eski/bozuk
  // tablo öylece kalır ve INSERT INTO ... (filename) VALUES ('001_x.sql')
  // "invalid input syntax for type integer" hatası verir.
  // Burada sütun tipini kontrol edip gerekirse otomatik düzeltiyoruz.
  const { rows } = await query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name = 'schema_migrations' AND column_name = 'filename'`,
  );

  const dataType = rows[0]?.data_type;
  const textLike = ["text", "character varying", "character"];

  if (dataType && !textLike.includes(dataType)) {
    console.warn(
      `[migrate] ⚠ schema_migrations.filename beklenmeyen tipte (${dataType}) — TEXT'e çevriliyor…`,
    );
    try {
      await query(
        `ALTER TABLE schema_migrations ALTER COLUMN filename TYPE TEXT USING filename::text`,
      );
      console.log("[migrate] ✓ schema_migrations.filename TEXT'e çevrildi.");
    } catch (e) {
      console.warn(
        "[migrate] ⚠ ALTER başarısız, tablo sıfırdan oluşturuluyor:",
        String(e.message || e),
      );
      await query(`DROP TABLE schema_migrations`);
      await query(`
        CREATE TABLE schema_migrations (
          id SERIAL PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      console.log("[migrate] ✓ schema_migrations yeniden oluşturuldu.");
    }
  }
}

async function alreadyApplied(filename) {
  const { rows } = await query(
    `SELECT 1 FROM schema_migrations WHERE filename = $1`,
    [filename],
  );
  return rows.length > 0;
}

async function markApplied(filename) {
  await query(
    `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
    [filename],
  );
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[migrate] DATABASE_URL tanımlı değil. Örnek: postgres://em:em@localhost:5432/elite_manager",
    );
    process.exit(1);
  }

  console.log("[migrate] başlıyor…");
  await ensureMigrationsTable();

  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) {
      console.warn("[migrate] atlandı (yok):", file);
      continue;
    }
    if (await alreadyApplied(file)) {
      console.log("[migrate] ✓ zaten uygulandı:", file);
      continue;
    }
    const sql = fs.readFileSync(full, "utf8");
    const client = await pool.connect();
    let appliedOk = false;
    let idempotent = false;
    let errMsg = "";
    try {
      // Bazı migration'lar kendi BEGIN/COMMIT'ini içeriyor; yine de güvenli çalıştır.
      await client.query(sql);
      appliedOk = true;
    } catch (e) {
      // Bir komut hata verince Postgres o transaction'ı "aborted" durumuna
      // sokar. ROLLBACK atıp client'ı bırakıyoruz; işaretlemeyi pool üzerinden
      // (temiz bağlantı) yapacağız — aksi halde pool'a bozuk bağlantı döner
      // ve sonraki alreadyApplied / query'ler 25P02 verir.
      try {
        await client.query("ROLLBACK");
      } catch (_) {}

      errMsg = String(e.message || e);
      if (
        /already exists|duplicate|IF NOT EXISTS/i.test(errMsg) ||
        e.code === "42P07" ||
        e.code === "42710"
      ) {
        idempotent = true;
        console.warn(
          "[migrate] ⚠ uyarı (devam):",
          file,
          "—",
          errMsg.slice(0, 120),
        );
      } else {
        console.error("[migrate] ✗ hata:", file, errMsg);
        try {
          client.release();
        } catch (_) {}
        await pool.end();
        process.exit(1);
      }
    } finally {
      try {
        client.release();
      } catch (_) {}
    }

    // İşaretleme her zaman pool.query ile (temiz bağlantı) yapılır.
    // Aynı client üzerinde bırakılan aborted state pool'u kirletmesin.
    try {
      await query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [file],
      );
      if (appliedOk) {
        console.log("[migrate] ✓ uygulandı:", file);
      } else if (idempotent) {
        console.log("[migrate] ✓ işaretlendi (zaten mevcuttu):", file);
      }
    } catch (e2) {
      console.error(
        "[migrate] ✗ işaretlenemedi:",
        file,
        "—",
        String(e2.message || e2),
      );
      await pool.end();
      process.exit(1);
    }
  }

  console.log("[migrate] tamam.");
  await pool.end();
}

run().catch(async (e) => {
  console.error("[migrate] fatal", e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
