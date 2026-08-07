// ============================================================
// adminAntiCheatRoutes.js — Anti-cheat log + ban (ADMIN only)
// ------------------------------------------------------------
//   app.use("/api/admin", authMiddleware, createAdminAntiCheatRouter());
// Env: ADMIN_USERNAME
// ============================================================

const express = require("express");
const { query } = require("./db");
const antiCheat = require("./antiCheat");

function requireAdmin(req, res) {
  try {
    const { isAdmin } = require("./nationalSystem");
    if (!isAdmin(req.user && req.user.username)) {
      res.status(403).json({ error: "Bu işlem için yetkin yok", code: "ADMIN_ONLY" });
      return false;
    }
    return true;
  } catch (e) {
    // nationalSystem yoksa env fallback
    const adminName = process.env.ADMIN_USERNAME;
    if (
      !adminName ||
      String(req.user && req.user.username).toLowerCase() !==
        String(adminName).toLowerCase()
    ) {
      res.status(403).json({ error: "Bu işlem için yetkin yok", code: "ADMIN_ONLY" });
      return false;
    }
    return true;
  }
}

async function resolveUser(target) {
  const t = String(target || "").trim();
  if (!t) return null;
  // id sayısal veya username
  if (/^\d+$/.test(t)) {
    const { rows } = await query(
      `SELECT id, username, is_banned, banned_until, ban_reason, banned_at, last_login_at
       FROM users WHERE id = $1`,
      [parseInt(t, 10)],
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `SELECT id, username, is_banned, banned_until, ban_reason, banned_at, last_login_at
     FROM users WHERE LOWER(username) = LOWER($1)`,
    [t],
  );
  return rows[0] || null;
}

function isCurrentlyBanned(row) {
  if (!row) return false;
  if (row.is_banned) {
    if (row.banned_until) {
      return new Date(row.banned_until).getTime() > Date.now();
    }
    return true; // süresiz
  }
  return false;
}

function createAdminAntiCheatRouter() {
  const router = express.Router();

  // GET /api/admin/anti-cheat/logs?limit=50&userId=&action=
  router.get("/anti-cheat/logs", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
      const action = req.query.action ? String(req.query.action).slice(0, 64) : null;

      const params = [];
      let where = "WHERE 1=1";
      if (userId) {
        params.push(userId);
        where += ` AND user_id = $${params.length}`;
      }
      if (action) {
        params.push(action);
        where += ` AND action = $${params.length}`;
      }
      params.push(limit);

      const { rows } = await query(
        `SELECT id, user_id, club_id, action, detail, created_at
         FROM anti_cheat_log
         ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      );
      res.json({ ok: true, logs: rows });
    } catch (e) {
      console.error("[admin/anti-cheat/logs]", e);
      res.status(500).json({ error: "Loglar alınamadı" });
    }
  });

  // GET /api/admin/anti-cheat/summary — son 24s özet
  router.get("/anti-cheat/summary", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { rows: byAction } = await query(
        `SELECT action, COUNT(*)::int AS cnt
         FROM anti_cheat_log
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY action
         ORDER BY cnt DESC`,
      );
      const { rows: topUsers } = await query(
        `SELECT user_id, COUNT(*)::int AS cnt
         FROM anti_cheat_log
         WHERE created_at > NOW() - INTERVAL '24 hours' AND user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY cnt DESC
         LIMIT 20`,
      );
      // usernames
      const ids = topUsers.map((r) => r.user_id).filter(Boolean);
      let nameMap = {};
      if (ids.length) {
        const { rows: users } = await query(
          `SELECT id, username, is_banned FROM users WHERE id = ANY($1::int[])`,
          [ids],
        );
        users.forEach((u) => {
          nameMap[u.id] = { username: u.username, is_banned: u.is_banned };
        });
      }
      const top = topUsers.map((r) => ({
        userId: r.user_id,
        count: r.cnt,
        username: (nameMap[r.user_id] && nameMap[r.user_id].username) || null,
        is_banned: (nameMap[r.user_id] && nameMap[r.user_id].is_banned) || false,
      }));
      res.json({ ok: true, last24h: { byAction, topUsers: top } });
    } catch (e) {
      console.error("[admin/anti-cheat/summary]", e);
      res.status(500).json({ error: "Özet alınamadı" });
    }
  });

  // GET /api/admin/user/:target — kullanıcı + son loglar
  router.get("/user/:target", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const user = await resolveUser(req.params.target);
      if (!user) return res.status(404).json({ error: "Kullanıcı yok" });
      const { rows: logs } = await query(
        `SELECT id, action, detail, created_at FROM anti_cheat_log
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [user.id],
      );
      let club = null;
      try {
        const clubsRepo = require("./repos/clubsRepo");
        club = await clubsRepo.getClubByUserId(user.id);
      } catch (e) {}
      res.json({
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          is_banned: !!user.is_banned,
          banned: isCurrentlyBanned(user),
          banned_until: user.banned_until,
          ban_reason: user.ban_reason,
          banned_at: user.banned_at,
          last_login_at: user.last_login_at,
        },
        club: club
          ? { id: club.id, name: club.name, balance: Number(club.balance) }
          : null,
        recentLogs: logs,
      });
    } catch (e) {
      console.error("[admin/user]", e);
      res.status(500).json({ error: "Kullanıcı alınamadı" });
    }
  });

  // POST /api/admin/ban  { target, reason?, hours? }
  // hours yok veya 0 = süresiz
  router.post("/ban", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const target = (req.body && (req.body.target || req.body.username || req.body.userId)) || "";
      const reason = String((req.body && req.body.reason) || "Admin ban").slice(0, 300);
      const hours = req.body && req.body.hours != null ? Number(req.body.hours) : null;

      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı yok" });
      if (String(user.username).toLowerCase() === String(req.user.username).toLowerCase()) {
        return res.status(400).json({ error: "Kendini banlayamazsın" });
      }

      let until = null;
      if (hours && hours > 0) {
        until = new Date(Date.now() + hours * 3600 * 1000);
      }

      await query(
        `UPDATE users SET
           is_banned = TRUE,
           banned_until = $2,
           ban_reason = $3,
           banned_at = NOW(),
           banned_by = $4
         WHERE id = $1`,
        [user.id, until ? until.toISOString() : null, reason, req.user.id],
      );

      await antiCheat.logSuspicious(user.id, null, "admin_ban", {
        by: req.user.username,
        reason,
        hours: hours || null,
        until: until ? until.toISOString() : null,
      });

      res.json({
        ok: true,
        userId: user.id,
        username: user.username,
        banned_until: until,
        reason,
      });
    } catch (e) {
      console.error("[admin/ban]", e);
      res.status(500).json({ error: "Ban uygulanamadı" });
    }
  });

  // POST /api/admin/unban  { target }
  router.post("/unban", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const target = (req.body && (req.body.target || req.body.username || req.body.userId)) || "";
      const user = await resolveUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı yok" });

      await query(
        `UPDATE users SET
           is_banned = FALSE,
           banned_until = NULL,
           ban_reason = NULL,
           banned_at = NULL,
           banned_by = NULL
         WHERE id = $1`,
        [user.id],
      );

      await antiCheat.logSuspicious(user.id, null, "admin_unban", {
        by: req.user.username,
      });

      res.json({ ok: true, userId: user.id, username: user.username });
    } catch (e) {
      console.error("[admin/unban]", e);
      res.status(500).json({ error: "Unban başarısız" });
    }
  });

  // GET /api/admin/banned — banlı listesi
  router.get("/banned", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { rows } = await query(
        `SELECT id, username, is_banned, banned_until, ban_reason, banned_at
         FROM users
         WHERE is_banned = TRUE
         ORDER BY banned_at DESC NULLS LAST
         LIMIT 100`,
      );
      res.json({
        ok: true,
        users: rows.map((u) => ({
          id: u.id,
          username: u.username,
          banned: isCurrentlyBanned(u),
          banned_until: u.banned_until,
          ban_reason: u.ban_reason,
          banned_at: u.banned_at,
        })),
      });
    } catch (e) {
      console.error("[admin/banned]", e);
      res.status(500).json({ error: "Liste alınamadı" });
    }
  });

  return router;
}

/** Login / middleware için ban durumu */
async function getBanStatus(userId) {
  const { rows } = await query(
    `SELECT is_banned, banned_until, ban_reason FROM users WHERE id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.is_banned) return { banned: false };

  // Süreli ban dolmuşsa otomatik kaldır
  if (row.banned_until && new Date(row.banned_until).getTime() <= Date.now()) {
    await query(
      `UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL,
         banned_at = NULL, banned_by = NULL WHERE id = $1`,
      [userId],
    );
    return { banned: false };
  }
  return {
    banned: true,
    until: row.banned_until,
    reason: row.ban_reason || "Hesap askıya alınmış",
  };
}

module.exports = {
  createAdminAntiCheatRouter,
  getBanStatus,
  isCurrentlyBanned,
};
