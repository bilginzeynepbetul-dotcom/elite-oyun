// ============================================================
// scripts/retention-cleanup.js — KVKK / operasyon saklama temizliği
// ------------------------------------------------------------
//   DATABASE_URL=... node scripts/retention-cleanup.js
//   node scripts/retention-cleanup.js --dry-run
//
// Ortam (gün):
//   RETENTION_ANTI_CHEAT_DAYS=90     (0 = silme)
//   RETENTION_ADMIN_AUDIT_DAYS=365   (0 = silme)
//   RETENTION_ACCOUNT_DELETION_LOG_DAYS=730
//   RETENTION_CLEAR_EXPIRED_EMAIL_TOKENS=1
// ============================================================

require("dotenv").config();
const { pool, query } = require("../db");

function daysEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function flag(name, defTrue) {
  const v = String(process.env[name] ?? (defTrue ? "1" : "0")).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function deleteOlderThan(table, column, days, dryRun) {
  if (!days || days <= 0) {
    return { table, skipped: true, reason: "disabled" };
  }
  const countSql = `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${column} < NOW() - ($1::text || ' days')::interval`;
  const { rows } = await query(countSql, [String(days)]);
  const c = rows[0] ? rows[0].c : 0;
  if (dryRun) {
    return { table, dryRun: true, wouldDelete: c, days };
  }
  if (c === 0) return { table, deleted: 0, days };
  const del = await query(
    `DELETE FROM ${table} WHERE ${column} < NOW() - ($1::text || ' days')::interval`,
    [String(days)],
  );
  return { table, deleted: del.rowCount || 0, days };
}

async function clearExpiredEmailTokens(dryRun) {
  if (!flag("RETENTION_CLEAR_EXPIRED_EMAIL_TOKENS", true)) {
    return { task: "email_tokens", skipped: true };
  }
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM users
     WHERE email_verify_token IS NOT NULL
       AND email_verify_expires IS NOT NULL
       AND email_verify_expires < NOW()`,
  );
  const c = rows[0] ? rows[0].c : 0;
  if (dryRun) {
    return { task: "email_tokens", dryRun: true, wouldClear: c };
  }
  if (c === 0) return { task: "email_tokens", cleared: 0 };
  const r = await query(
    `UPDATE users SET email_verify_token = NULL, email_verify_expires = NULL
     WHERE email_verify_token IS NOT NULL
       AND email_verify_expires IS NOT NULL
       AND email_verify_expires < NOW()`,
  );
  return { task: "email_tokens", cleared: r.rowCount || 0 };
}

async function main() {
  const dryRun =
    process.argv.includes("--dry-run") ||
    process.argv.includes("-n") ||
    flag("RETENTION_DRY_RUN", false);

  console.log("[retention] start", dryRun ? "(dry-run)" : "");

  const results = [];

  results.push(await clearExpiredEmailTokens(dryRun));

  results.push(
    await deleteOlderThan(
      "anti_cheat_log",
      "created_at",
      daysEnv("RETENTION_ANTI_CHEAT_DAYS", 90),
      dryRun,
    ),
  );

  results.push(
    await deleteOlderThan(
      "admin_audit_log",
      "created_at",
      daysEnv("RETENTION_ADMIN_AUDIT_DAYS", 365),
      dryRun,
    ),
  );

  // account_deletion_log — tablo yoksa yut
  try {
    results.push(
      await deleteOlderThan(
        "account_deletion_log",
        "created_at",
        daysEnv("RETENTION_ACCOUNT_DELETION_LOG_DAYS", 730),
        dryRun,
      ),
    );
  } catch (e) {
    results.push({
      table: "account_deletion_log",
      error: String(e.message || e),
    });
  }

  console.log("[retention] results:", JSON.stringify(results, null, 2));
  console.log("[retention] done");
  await pool.end();
}

main().catch(async (e) => {
  console.error("[retention] fatal", e);
  try {
    await pool.end();
  } catch (_) {}
  process.exit(1);
});
