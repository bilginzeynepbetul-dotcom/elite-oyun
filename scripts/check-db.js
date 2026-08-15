// ============================================================
// scripts/check-db.js — DB bağlantı + temel tablo kontrolü
// ============================================================

require("dotenv").config();
const { pool, query } = require("../db");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL yok");
    process.exit(1);
  }
  console.log("[check-db] bağlanıyor…");
  const { rows } = await query("SELECT NOW() AS now, current_database() AS db");
  console.log("  ✓ connected", rows[0].db, rows[0].now);

  const tables = [
    "users",
    "clubs",
    "players",
    "seasons",
    "fixtures",
    "transfer_listings",
    "youth_academy",
    "stadiums",
    "game_settings",
  ];
  for (const t of tables) {
    try {
      const r = await query(`SELECT COUNT(*)::int AS c FROM ${t}`);
      console.log("  ✓", t, "rows=", r.rows[0].c);
    } catch (e) {
      console.error("  ✗", t, e.message);
    }
  }

  try {
    const m = await query(
      `SELECT filename FROM schema_migrations ORDER BY id`,
    );
    console.log("  migrations:", m.rows.length);
  } catch (_) {
    console.log("  · schema_migrations yok (henüz migrate edilmemiş olabilir)");
  }

  await pool.end();
  console.log("[check-db] OK");
}

main().catch(async (e) => {
  console.error("[check-db] FAIL", e.message);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
