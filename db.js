// ============================================================
// db.js — PostgreSQL pool (pg)
// ------------------------------------------------------------
//   const { pool, query, withTransaction } = require("./db");
//   // DATABASE_URL=postgres://user:pass@host:5432/elite_manager
// ============================================================

const { Pool } = require("pg");

// Supabase (ve çoğu barındırılan Postgres) bağlantıda SSL zorunlu tutar.
// Yerel Docker/localhost DB'de SSL gerekmiyor, o yüzden adrese göre otomatik karar veriyoruz.
// Zorlamak/kapatmak istersen PGSSL=require veya PGSSL=disable ile ez.
//
// ÖNEMLİ: Supabase'in verdiği URL'de "?sslmode=require" geçebiliyor; pg's
// connection-string parser bunu (yeni sürümlerde) "verify-full" gibi
// yorumlayıp bizim aşağıdaki ssl ayarımızı ezebiliyor ve
// "self-signed certificate in certificate chain" hatasına yol açabiliyor.
// Bunu önlemek için sslmode'u URL'den temizleyip SSL kararını tamamen
// burada veriyoruz.
function stripSslMode(url) {
  if (!url) return url;
  return url.replace(/([?&])sslmode=[^&]*&?/i, "$1").replace(/[?&]$/, "");
}

function resolveSsl() {
  const mode = String(process.env.PGSSL || "").toLowerCase();
  // verify = CA doğrulamalı (sıkı); require = TLS var, self-signed kabul
  // disable = SSL yok; boş = local değilse require (Supabase uyumu)
  if (mode === "disable" || mode === "false" || mode === "0") return false;
  if (mode === "verify" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  if (mode === "require") return { rejectUnauthorized: false };
  const url = process.env.DATABASE_URL || "";
  const isLocal = /localhost|127\.0\.0\.1|@db:/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: stripSslMode(process.env.DATABASE_URL),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  ssl: resolveSsl(),
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
