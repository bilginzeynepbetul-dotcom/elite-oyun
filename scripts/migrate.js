require("dotenv").config();
const fs = require("fs");
const path = require("path");
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
  "013_game_settings.sql",
  "014_calendar_friendlies.sql",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }
  const client = new Client({ connectionString: stripSslMode(url), ssl: resolveSsl(url) });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const f of files) {
    const { rows } = await client.query(
      `SELECT 1 FROM schema_migrations WHERE id = $1`,
      [f],
    );
    if (rows.length) {
      console.log("[migrate] skip", f);
      continue;
    }
    const sql = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    console.log("[migrate] apply", f);
    await client.query(sql);
    await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [f]);
  }
  await client.end();
  console.log("[migrate] done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
