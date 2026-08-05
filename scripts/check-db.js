// ============================================================
// scripts/check-db.js — Supabase bağlantısı + migration teşhisi
// Kullanım:  npm run check-db
// ============================================================

require("dotenv").config();
const { Client } = require("pg");

function stripSslMode(url) {
  if (!url) return url;
  return url.replace(/([?&])sslmode=[^&]*&?/i, "$1").replace(/[?&]$/, "");
}

function resolveSsl(url) {
  const mode = process.env.PGSSL;
  if (mode === "require") return { rejectUnauthorized: false };
  if (mode === "disable") return false;
  const isLocal = /localhost|127\.0\.0\.1|@db:/.test(url || "");
  return isLocal ? false : { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  console.log("1) .env okundu mu?");
  if (!url) {
    console.log("   ✗ DATABASE_URL bulunamadı. .env dosyasını kontrol et.");
    process.exit(1);
  }
  console.log("   ✓ DATABASE_URL var (", url.replace(/:[^:@]*@/, ":****@"), ")");

  const client = new Client({ connectionString: stripSslMode(url), ssl: resolveSsl(url) });

  console.log("\n2) Supabase'e bağlanılıyor...");
  try {
    await client.connect();
    console.log("   ✓ Bağlantı başarılı");
  } catch (e) {
    console.log("   ✗ Bağlantı BAŞARISIZ:", e.message);
    console.log("\n   Olası sebepler: yanlış şifre, yanlış proje URL'i, veya");
    console.log("   Supabase panelinde 'Connection string' i tekrar kopyala.");
    process.exit(1);
  }

  console.log("\n3) Migration'lar uygulanmış mı?");
  try {
    const { rows } = await client.query(
      `SELECT id FROM schema_migrations ORDER BY id`,
    );
    const applied = rows.map((r) => r.id);
    const expected = [
      "001_init_schema.sql",
      "002_register_club_fn.sql",
      "003_bot_clubs.sql",
      "004_transfer_id_text.sql",
    ];
    expected.forEach((f) => {
      console.log(applied.includes(f) ? `   ✓ ${f}` : `   ✗ ${f} UYGULANMAMIŞ`);
    });
    if (expected.some((f) => !applied.includes(f))) {
      console.log("\n   → Eksik migration var. 'npm run migrate' çalıştır.");
    }
  } catch (e) {
    console.log("   ✗ schema_migrations tablosu yok — hiç migration çalışmamış.");
    console.log("   → 'npm run migrate' çalıştır.");
    await client.end();
    process.exit(1);
  }

  console.log("\n4) Kritik tablo/fonksiyonlar mevcut mu?");
  const checks = [
    ["tablo: users", `SELECT to_regclass('public.users') AS x`],
    ["tablo: clubs", `SELECT to_regclass('public.clubs') AS x`],
    ["tablo: players", `SELECT to_regclass('public.players') AS x`],
    ["fonksiyon: register_new_club", `SELECT proname FROM pg_proc WHERE proname = 'register_new_club'`],
  ];
  for (const [label, sql] of checks) {
    const { rows } = await client.query(sql);
    const ok = rows.length && (rows[0].x || rows[0].proname);
    console.log(ok ? `   ✓ ${label}` : `   ✗ ${label} BULUNAMADI`);
  }

  console.log("\n5) Deneme kaydı (gerçekten INSERT dener, sonda geri alır)");
  try {
    await client.query("BEGIN");
    const testUser = await client.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
      ["__check_db_test__", "x"],
    );
    const reg = await client.query(
      `SELECT * FROM register_new_club($1::uuid, $2::text, $3::text)`,
      [testUser.rows[0].id, "__check_db_test__", "Test SK"],
    );
    console.log("   ✓ register_new_club çalıştı, club_id:", reg.rows[0].club_id);
    await client.query("ROLLBACK");
    console.log("   (test verisi geri alındı, DB'de kalıcı değişiklik yok)");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.log("   ✗ register_new_club HATA VERDİ:");
    console.log("     ", e.message);
    console.log("\n   → Bu, kayıt formunun neden başarısız olduğunun asıl sebebi.");
  }

  await client.end();
  console.log("\nBitti.");
}

main().catch((e) => {
  console.error("Beklenmeyen hata:", e);
  process.exit(1);
});
