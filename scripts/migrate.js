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
  "028_national_schema_ensure.sql",
  "029_username_ci_unique.sql",
  "030_account_deletion.sql",
  "031_account_deletion_audit.sql",
  "032_admin_audit_log.sql",
  "033_email_verification.sql",
  "034_login_lockout.sql",
  "035_messages_is_read.sql",
  "036_youth_branches.sql",
  "037_youth_home_draws.sql",
];

async function ensureMigrationsTable() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (e) {
    if (e.code === "42501") {
      console.error(
        "[migrate] ✗ schema_migrations oluşturulamadı (42501 yetki yok).",
      );
      console.error(
        "[migrate]   DATABASE_URL içindeki kullanıcının bu veritabanında",
      );
      console.error(
        "[migrate]   CREATE TABLE yetkisi olmalı. Render/Supabase'te genelde",
      );
      console.error(
        "[migrate]   varsayılan connection string yeterlidir; yanlış DB veya",
      );
      console.error(
        "[migrate]   read-only replica kullanmadığınızdan emin olun.",
      );
    }
    throw e;
  }

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

function maskDatabaseUrl(url) {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:/i, "http:"));
    const user = u.username || "?";
    const host = u.hostname || "?";
    const port = u.port || "";
    const db = (u.pathname || "/").replace(/^\//, "") || "?";
    return `${user}@${host}${port ? ":" + port : ""}/${db}`;
  } catch (_) {
    return "(parse edilemedi)";
  }
}

async function diagnosePrivileges() {
  try {
    const { rows } = await query(
      `SELECT current_user AS usr,
              current_database() AS db,
              has_database_privilege(current_user, current_database(), 'CREATE') AS can_create`,
    );
    const r = rows[0] || {};
    console.log(
      `[migrate] bağlantı: user=${r.usr} db=${r.db} CREATE=${r.can_create}`,
    );
    if (r.can_create === false) {
      console.error(
        "[migrate] ✗ Bu kullanıcının veritabanında CREATE yetkisi YOK (42501 kaynağı).",
      );
      console.error(
        "[migrate]   Çözüm özeti:",
      );
      console.error(
        "[migrate]   • Render: Dashboard → Database → Connect → External/Internal URL (owner user)",
      );
      console.error(
        "[migrate]   • Supabase: Project Settings → Database → Connection string (URI)",
      );
      console.error(
        "[migrate]     session mode kullan (port 5432), pooler 6543 transaction mode değil",
      );
      console.error(
        "[migrate]   • Yerel Docker: postgres://em:em@localhost:5432/elite_manager",
      );
      console.error(
        "[migrate]   • Read-only replica / viewer role kullanmayın",
      );
      await pool.end();
      process.exit(1);
    }
  } catch (e) {
    console.warn(
      "[migrate] yetki teşhisi atlandı:",
      String(e.message || e).slice(0, 120),
    );
  }
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "[migrate] DATABASE_URL tanımlı değil. Örnek: postgres://em:em@localhost:5432/elite_manager",
    );
    process.exit(1);
  }

  console.log("[migrate] başlıyor…");
  console.log("[migrate] hedef:", maskDatabaseUrl(process.env.DATABASE_URL));
  await diagnosePrivileges();
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
        if (e.code === "42501") {
          console.error(
            "[migrate] 💡 42501 = yetersiz yetki (insufficient_privilege).",
          );
          console.error(
            "[migrate]    • CREATE EXTENSION artık kullanılmıyor (PG 14+).",
          );
          console.error(
            "[migrate]    • DB kullanıcısının CREATE / CREATE TABLE yetkisi olmalı.",
          );
          console.error(
            "[migrate]    • Read-only replica veya yanlış DATABASE_URL kullanmayın.",
          );
        }
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
