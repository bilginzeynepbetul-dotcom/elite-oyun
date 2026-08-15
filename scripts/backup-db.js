// ============================================================
// scripts/backup-db.js — PostgreSQL yedekleme (pg_dump)
// ------------------------------------------------------------
//   DATABASE_URL=... node scripts/backup-db.js
//   node scripts/backup-db.js --out /var/backups/elite
//   node scripts/backup-db.js --keep 14
//
// Ortam:
//   DATABASE_URL          (zorunlu)
//   BACKUP_DIR            varsayılan: ./backups
//   BACKUP_KEEP           saklanacak dosya sayısı (0 = silme yok)
//   BACKUP_PREFIX         varsayılan: elite-oyun
// ============================================================

require("dotenv").config();
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function parseDatabaseUrl(urlStr) {
  if (!urlStr) throw new Error("DATABASE_URL tanımlı değil");
  const u = new URL(urlStr);
  return {
    host: u.hostname || "localhost",
    port: u.port || "5432",
    user: decodeURIComponent(u.username || "postgres"),
    password: decodeURIComponent(u.password || ""),
    database: (u.pathname || "/postgres").replace(/^\//, "") || "postgres",
  };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const conf = parseDatabaseUrl(dbUrl);

  const outDir = path.resolve(
    argVal("--out", process.env.BACKUP_DIR || path.join(process.cwd(), "backups")),
  );
  const keep = Number(argVal("--keep", process.env.BACKUP_KEEP || "14")) || 0;
  const prefix = process.env.BACKUP_PREFIX || "elite-oyun";

  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const fileName = `${prefix}_${stamp}.sql.gz`;
  const outPath = path.join(outDir, fileName);

  console.log("[backup] hedef:", outPath);
  console.log("[backup] db:", conf.host + ":" + conf.port + "/" + conf.database);

  const env = { ...process.env, PGPASSWORD: conf.password };

  const dump = spawn(
    "pg_dump",
    [
      "-h",
      conf.host,
      "-p",
      String(conf.port),
      "-U",
      conf.user,
      "-d",
      conf.database,
      "--no-owner",
      "--no-acl",
      "--clean",
      "--if-exists",
      "--format=plain",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  const gzip = spawn("gzip", ["-c"], { stdio: ["pipe", "pipe", "pipe"] });
  const out = fs.createWriteStream(outPath);

  dump.stdout.pipe(gzip.stdin);
  gzip.stdout.pipe(out);

  let errBuf = "";
  dump.stderr.on("data", (d) => {
    errBuf += d.toString();
  });
  gzip.stderr.on("data", (d) => {
    errBuf += d.toString();
  });

  const code = await new Promise((resolve) => {
    let left = 2;
    let dumpCode = 0;
    let gzipCode = 0;
    const done = () => {
      left -= 1;
      if (left === 0) resolve(dumpCode || gzipCode);
    };
    dump.on("close", (c) => {
      dumpCode = c || 0;
      // gzip stdin kapanınca gzip de biter
      done();
    });
    gzip.on("close", (c) => {
      gzipCode = c || 0;
      done();
    });
    out.on("error", (e) => {
      errBuf += String(e);
      resolve(1);
    });
  });

  if (code !== 0) {
    try {
      fs.unlinkSync(outPath);
    } catch (_) {}
    console.error("[backup] HATA:", errBuf.slice(0, 2000) || "pg_dump/gzip başarısız");
    process.exit(1);
  }

  const st = fs.statSync(outPath);
  console.log(
    "[backup] tamam:",
    outPath,
    "(" + Math.round(st.size / 1024) + " KB)",
  );

  // Eski yedekleri temizle
  if (keep > 0) {
    const files = fs
      .readdirSync(outDir)
      .filter((f) => f.startsWith(prefix + "_") && f.endsWith(".sql.gz"))
      .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    const toDelete = files.slice(keep);
    for (const d of toDelete) {
      const p = path.join(outDir, d.f);
      try {
        fs.unlinkSync(p);
        console.log("[backup] silindi (keep=" + keep + "):", d.f);
      } catch (e) {
        console.warn("[backup] silinemedi:", d.f, e.message);
      }
    }
  }

  console.log("[backup] bitti");
}

main().catch((e) => {
  console.error("[backup] fatal:", e.message || e);
  process.exit(1);
});
