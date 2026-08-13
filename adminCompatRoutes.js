// ============================================================
// adminCompatRoutes.js — /api/admin/* (istemci uyumlu ban + anket)
// multiplayer-client: /api/admin/ban, /unban, /banned, /user/:id
// ============================================================

const express = require("express");
const { query } = require("./db");
const { isAdmin } = require("./authMiddleware");
const clubsRepo = require("./repos/clubsRepo");

function createAdminCompatRouter() {
  const router = express.Router();

  async function findUser(target) {
    const t = String(target || "").trim();
    if (!t) return null;
    const { rows } = await query(
      `SELECT id, username, email, is_banned, banned_until, ban_reason, created_at
       FROM users
       WHERE username ILIKE $1 OR id::text = $2
       LIMIT 1`,
      [t, t],
    );
    return rows[0] || null;
  }

  // POST /api/admin/ban  { target, reason?, hours? }
  router.post("/ban", isAdmin, async (req, res) => {
    try {
      const target = (req.body && req.body.target) || "";
      const reason = (req.body && req.body.reason) || "Kural ihlali";
      let hours = req.body && req.body.hours;
      const user = await findUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

      let bannedUntil = null;
      const h = hours === "" || hours == null ? null : Number(hours);
      if (h != null && !isNaN(h) && h > 0) {
        bannedUntil = new Date(Date.now() + h * 60 * 60 * 1000);
      } else {
        // süresiz: 10 yıl
        bannedUntil = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
      }

      await query(
        `UPDATE users
         SET is_banned = TRUE, banned_until = $1, ban_reason = $2
         WHERE id = $3`,
        [bannedUntil, reason, user.id],
      );

      try {
        await query(
          `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id, meta)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            user.id,
            "admin_ban",
            reason,
            req.user && (req.user.id || req.user.sub),
            JSON.stringify({ hours: h, banned_until: bannedUntil }),
          ],
        );
      } catch (e) {
        // log tablosu yoksa ban yine geçerli
      }

      res.json({
        ok: true,
        success: true,
        username: user.username,
        banned_until: bannedUntil,
        message:
          user.username +
          (h ? " " + h + " saat banlandı" : " süresiz banlandı"),
      });
    } catch (e) {
      console.error("[admin ban]", e);
      res.status(500).json({ error: e.message || "Ban başarısız" });
    }
  });

  router.post("/unban", isAdmin, async (req, res) => {
    try {
      const target = (req.body && req.body.target) || "";
      const user = await findUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      await query(
        `UPDATE users
         SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL
         WHERE id = $1`,
        [user.id],
      );
      try {
        await query(
          `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id)
           VALUES ($1, $2, $3, $4)`,
          [
            user.id,
            "admin_unban",
            "Admin tarafından kaldırıldı",
            req.user && (req.user.id || req.user.sub),
          ],
        );
      } catch (e) {}
      res.json({
        ok: true,
        success: true,
        username: user.username,
        message: user.username + " banı kaldırıldı",
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Unban başarısız" });
    }
  });

  router.get("/banned", isAdmin, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, username, is_banned, banned_until, ban_reason
         FROM users
         WHERE is_banned = TRUE
            OR (banned_until IS NOT NULL AND banned_until > NOW())
         ORDER BY banned_until DESC NULLS LAST`,
      );
      res.json({ users: rows, banned_users: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/user/:target", isAdmin, async (req, res) => {
    try {
      const user = await findUser(req.params.target);
      if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
      let club = null;
      try {
        club = await clubsRepo.getClubByUserId(user.id);
      } catch (e) {}
      const banned =
        !!user.is_banned ||
        (user.banned_until && new Date(user.banned_until) > new Date());
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          is_banned: banned,
          banned: banned,
          banned_until: user.banned_until,
          ban_reason: user.ban_reason,
        },
        club: club
          ? { id: club.id, name: club.name, country: club.country }
          : null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Anketler (in-memory + optional DB-less) ----
  if (!global.__emPolls) global.__emPolls = [];

  router.get("/polls", async (req, res) => {
    const polls = (global.__emPolls || []).filter((p) => p.active !== false);
    res.json({ polls });
  });

  router.post("/polls", isAdmin, async (req, res) => {
    try {
      const q = String((req.body && req.body.question) || "").trim();
      const options = (req.body && req.body.options) || [];
      if (!q || !Array.isArray(options) || options.length < 2) {
        return res.status(400).json({ error: "Soru ve en az 2 seçenek gerekli" });
      }
      const poll = {
        id: "poll_" + Date.now(),
        question: q.slice(0, 200),
        options: options.slice(0, 8).map((o) => String(o).slice(0, 80)),
        votes: {},
        active: true,
        createdAt: new Date().toISOString(),
        createdBy: req.user && req.user.username,
      };
      global.__emPolls.unshift(poll);
      global.__emPolls = global.__emPolls.slice(0, 30);
      res.json({ ok: true, poll });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/polls/:id/vote", async (req, res) => {
    try {
      const poll = (global.__emPolls || []).find(
        (p) => p.id === req.params.id && p.active !== false,
      );
      if (!poll) return res.status(404).json({ error: "Anket yok" });
      const option = String((req.body && req.body.option) || "");
      if (!poll.options.includes(option)) {
        return res.status(400).json({ error: "Geçersiz seçenek" });
      }
      const uid = String(
        (req.user && (req.user.id || req.user.sub)) || "anon",
      );
      poll.votes[uid] = option;
      const counts = {};
      poll.options.forEach((o) => {
        counts[o] = 0;
      });
      Object.values(poll.votes).forEach((v) => {
        if (counts[v] != null) counts[v]++;
      });
      res.json({ ok: true, counts, total: Object.keys(poll.votes).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/polls/:id/close", isAdmin, async (req, res) => {
    const poll = (global.__emPolls || []).find((p) => p.id === req.params.id);
    if (!poll) return res.status(404).json({ error: "Anket yok" });
    poll.active = false;
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createAdminCompatRouter };
