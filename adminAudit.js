// ============================================================
// adminAudit.js — merkezi admin işlem logu
// ============================================================

const { query } = require("./db");

/**
 * @param {object} opts
 * @param {string|null} opts.adminId
 * @param {string} opts.action  e.g. ban, unban, account_delete, donation_review
 * @param {string|null} [opts.targetUserId]
 * @param {string|null} [opts.targetLabel]
 * @param {object} [opts.details]
 * @param {string|null} [opts.ip]
 */
async function writeAdminAudit(opts) {
  const adminId = opts && opts.adminId ? opts.adminId : null;
  const action = String((opts && opts.action) || "unknown").slice(0, 64);
  const targetUserId = (opts && opts.targetUserId) || null;
  const targetLabel = opts && opts.targetLabel
    ? String(opts.targetLabel).slice(0, 128)
    : null;
  const details =
    opts && opts.details && typeof opts.details === "object"
      ? opts.details
      : {};
  const ip = opts && opts.ip ? String(opts.ip).slice(0, 64) : null;
  try {
    await query(
      `INSERT INTO admin_audit_log
         (admin_id, action, target_user_id, target_label, details, ip)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        adminId,
        action,
        targetUserId,
        targetLabel,
        JSON.stringify(details),
        ip,
      ],
    );
  } catch (e) {
    console.warn("[adminAudit]", e.message || e);
  }
}

function clientIp(req) {
  if (!req) return null;
  return (
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    null
  );
}

module.exports = { writeAdminAudit, clientIp };
