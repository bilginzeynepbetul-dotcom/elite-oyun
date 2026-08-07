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

  const projectRoot = path.join(__dirname, "..");
  console.log("[migrate] project root:", projectRoot);
  console.log("[migrate] cwd:", process.cwd());

  for (const f of files) {
    const { rows } = await client.query(
      `SELECT 1 FROM schema_migrations WHERE id = $1`,
      [f],
    );
    if (rows.length) {
      console.log("[migrate] skip", f);
      continue;
    }
    const filePath = path.join(projectRoot, f);
    if (!fs.existsSync(filePath)) {
      console.error(`[migrate] DOSYA BULUNAMADI: ${filePath}`);
      console.error(
        "[migrate] Bu dosya repoda/deploy edilen kaynakta yok. Git'e commit/push edildiğinden ve Render Root Directory ayarının doğru olduğundan emin olun.",
      );
      await client.end();
      process.exit(1);
    }
    const sql = fs.readFileSync(filePath, "utf8");
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
