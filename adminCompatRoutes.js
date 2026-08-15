// ============================================================
// adminCompatRoutes.js — /api/admin/* (istemci uyumlu ban + anket)
// multiplayer-client: /api/admin/ban, /unban, /banned, /user/:id
// ============================================================

const express = require("express");
const { query } = require("./db");
const { isAdmin } = require("./authMiddleware");
const clubsRepo = require("./repos/clubsRepo");
const { writeAdminAudit, clientIp } = require("./adminAudit");

function createAdminCompatRouter() {
  const router = express.Router();

  async function findUser(target) {
    const t = String(target || "").trim();
    if (!t) return null;
    const { rows } = await query(
      `SELECT id, username, email, is_banned, banned_until, ban_reason, created_at,
              COALESCE(failed_login_count, 0) AS failed_login_count,
              locked_until
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
          `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
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

      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: "ban",
        targetUserId: user.id,
        targetLabel: user.username,
        details: { reason, hours: h, banned_until: bannedUntil },
        ip: clientIp(req),
      });

            try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          global.__emDisconnectUserSockets(user.id, "BANNED");
        }
      } catch (_) {}

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
         SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL, failed_login_count = 0, locked_until = NULL
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
      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: "unban",
        targetUserId: user.id,
        targetLabel: user.username,
        details: { reason: "Admin tarafından kaldırıldı" },
        ip: clientIp(req),
      });
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
      const locked =
        !!(user.locked_until && new Date(user.locked_until) > new Date());
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          is_banned: banned,
          banned: banned,
          banned_until: user.banned_until,
          ban_reason: user.ban_reason,
          failed_login_count: Number(user.failed_login_count || 0),
          locked_until: user.locked_until || null,
          is_locked: locked,
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


  // GET /api/admin/audit-log?limit=50
  router.get("/audit-log", isAdmin, async (req, res) => {
    try {
      const lim = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const { rows } = await query(
        `SELECT a.id, a.action, a.target_user_id, a.target_label, a.details,
                a.ip, a.created_at,
                u.username AS admin_username
         FROM admin_audit_log a
         LEFT JOIN users u ON u.id = a.admin_id
         ORDER BY a.created_at DESC
         LIMIT $1`,
        [lim],
      );
      res.json({ logs: rows });
    } catch (e) {
      res.status(500).json({ error: e.message || "Audit log okunamadı" });
    }
  });


  // POST /api/admin/retention-run  { dryRun?: boolean }
  router.post("/retention-run", isAdmin, async (req, res) => {
    try {
      const dryRun = !!(req.body && req.body.dryRun);
      const { writeAdminAudit, clientIp } = require("./adminAudit");
      const { spawn } = require("child_process");
      const path = require("path");
      const args = [path.join(__dirname, "scripts", "retention-cleanup.js")];
      if (dryRun) args.push("--dry-run");
      const child = spawn(process.execPath, args, {
        env: process.env,
        cwd: path.join(__dirname),
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      child.on("close", async (code) => {
        await writeAdminAudit({
          adminId: req.user && (req.user.id || req.user.sub),
          action: "retention_run",
          targetUserId: null,
          targetLabel: dryRun ? "dry-run" : "apply",
          details: { code, out: out.slice(-2000), err: err.slice(-1000) },
          ip: clientIp(req),
        });
        if (code !== 0) {
          return res.status(500).json({
            error: "Retention script hata",
            code,
            log: (out + "\n" + err).slice(-3000),
          });
        }
        res.json({
          ok: true,
          dryRun,
          log: out.slice(-4000),
        });
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Retention başarısız" });
    }
  });


  // ============================================================
  // Login kilidi (brute-force) — manuel açma + liste
  // POST /api/admin/unlock-login  { target }
  // GET  /api/admin/locked
  // ============================================================
  router.post("/unlock-login", isAdmin, async (req, res) => {
    try {
      const target = (req.body && (req.body.target || req.body.username)) || "";
      const user = await findUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

      const wasLocked =
        !!(user.locked_until && new Date(user.locked_until) > new Date());
      const prevFails = Number(user.failed_login_count || 0);
      const prevLockedUntil = user.locked_until || null;

      await query(
        `UPDATE users
         SET failed_login_count = 0, locked_until = NULL
         WHERE id = $1`,
        [user.id],
      );

      try {
        await query(
          `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            user.id,
            "admin_unlock_login",
            "Admin tarafından giriş kilidi açıldı",
            req.user && (req.user.id || req.user.sub),
            JSON.stringify({
              was_locked: wasLocked,
              previous_failed_login_count: prevFails,
              previous_locked_until: prevLockedUntil,
            }),
          ],
        );
      } catch (e) {
        // log tablosu yoksa devam
      }

      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: "unlock_login",
        targetUserId: user.id,
        targetLabel: user.username,
        details: {
          was_locked: wasLocked,
          previous_failed_login_count: prevFails,
          previous_locked_until: prevLockedUntil,
        },
        ip: clientIp(req),
      });

      res.json({
        ok: true,
        success: true,
        username: user.username,
        was_locked: wasLocked,
        previous_failed_login_count: prevFails,
        previous_locked_until: prevLockedUntil,
        message: wasLocked
          ? user.username + " giriş kilidi açıldı"
          : user.username + " zaten kilitli değildi (sayaç sıfırlandı)",
      });
    } catch (e) {
      console.error("[admin unlock-login]", e);
      res.status(500).json({ error: e.message || "Kilit açma başarısız" });
    }
  });

  router.get("/locked", isAdmin, async (req, res) => {
    try {
      const { rows } = await query(
        `SELECT id, username, email,
                COALESCE(failed_login_count, 0) AS failed_login_count,
                locked_until,
                is_banned, banned_until, ban_reason
         FROM users
         WHERE locked_until IS NOT NULL AND locked_until > NOW()
         ORDER BY locked_until DESC`,
      );
      res.json({
        users: rows,
        locked_users: rows,
        count: rows.length,
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Kilitli kullanıcılar okunamadı" });
    }
  });


  // ============================================================
  // Runtime bakım modu (game_settings) — env MAINTENANCE_MODE=1 iken kilitli
  // GET  /api/admin/maintenance
  // POST /api/admin/maintenance  { enabled: boolean, message?: string }
  // ============================================================
  router.get("/maintenance", isAdmin, async (req, res) => {
    try {
      const seasonConfig = require("./seasonConfig");
      const envOn =
        ["1", "true", "yes", "on"].indexOf(
          String(process.env.MAINTENANCE_MODE || "").toLowerCase(),
        ) >= 0;
      const raw = await seasonConfig.getSetting("maintenance_mode", "0");
      const msg = await seasonConfig.getSetting("maintenance_message", null);
      const dbOn =
        String(raw || "0") === "1" ||
        String(raw || "").toLowerCase() === "true";
      res.json({
        ok: true,
        enabled: envOn || dbOn,
        envForced: envOn,
        dbEnabled: dbOn,
        message:
          msg ||
          process.env.MAINTENANCE_MESSAGE ||
          "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.",
        source: envOn ? "env" : dbOn ? "db" : "off",
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Bakım durumu okunamadı" });
    }
  });

  router.post("/maintenance", isAdmin, async (req, res) => {
    try {
      const envOn =
        ["1", "true", "yes", "on"].indexOf(
          String(process.env.MAINTENANCE_MODE || "").toLowerCase(),
        ) >= 0;
      if (envOn) {
        return res.status(409).json({
          error:
            "MAINTENANCE_MODE env açık — runtime ile kapatılamaz. Env'i kaldırıp restart edin.",
          code: "ENV_FORCED",
        });
      }
      const enabled = !!(req.body && req.body.enabled);
      let message =
        req.body && req.body.message != null
          ? String(req.body.message).trim().slice(0, 300)
          : null;
      const seasonConfig = require("./seasonConfig");
      await seasonConfig.setSetting("maintenance_mode", enabled ? "1" : "0");
      if (message != null && message.length) {
        await seasonConfig.setSetting("maintenance_message", message);
      } else if (!enabled) {
        // kapatırken mesajı koru (tekrar açınca aynı metin)
      }
      try {
        if (typeof global.__emInvalidateMaintenanceCache === "function") {
          global.__emInvalidateMaintenanceCache();
        }
      } catch (_) {}
      // Tüm bağlı istemcilere anında bildir
      try {
        const getIo =
          typeof global.__emGetIo === "function" ? global.__emGetIo : null;
        const io = getIo ? getIo() : null;
        if (io) {
          const payload = {
            enabled: !!enabled,
            message:
              message ||
              process.env.MAINTENANCE_MESSAGE ||
              "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.",
          };
          io.emit("maintenance:status", payload);
        }
      } catch (_) {}
      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: enabled ? "maintenance_on" : "maintenance_off",
        targetUserId: null,
        targetLabel: "system",
        details: { enabled, message: message || null },
        ip: clientIp(req),
      });
      const msgOut =
        message ||
        (await seasonConfig.getSetting("maintenance_message", null)) ||
        process.env.MAINTENANCE_MESSAGE ||
        "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.";
      res.json({
        ok: true,
        enabled,
        message: msgOut,
        source: "db",
      });
    } catch (e) {
      console.error("[admin maintenance]", e);
      res.status(500).json({ error: e.message || "Bakım ayarlanamadı" });
    }
  });


  // ============================================================
  // Güvenlik özeti — tek bakışta kilit / ban / bakım / son olaylar
  // GET /api/admin/security-overview
  // ============================================================
  router.get("/security-overview", isAdmin, async (req, res) => {
    try {
      const seasonConfig = require("./seasonConfig");
      const envOn =
        ["1", "true", "yes", "on"].indexOf(
          String(process.env.MAINTENANCE_MODE || "").toLowerCase(),
        ) >= 0;
      let dbMaint = "0";
      let maintMsg = null;
      try {
        dbMaint = await seasonConfig.getSetting("maintenance_mode", "0");
        maintMsg = await seasonConfig.getSetting("maintenance_message", null);
      } catch (_) {}
      const dbOn =
        String(dbMaint || "0") === "1" ||
        String(dbMaint || "").toLowerCase() === "true";

      const [lockedR, bannedR, auditR, usersR] = await Promise.all([
        query(
          `SELECT id, username, COALESCE(failed_login_count, 0) AS failed_login_count,
                  locked_until
           FROM users
           WHERE locked_until IS NOT NULL AND locked_until > NOW()
           ORDER BY locked_until DESC
           LIMIT 20`,
        ),
        query(
          `SELECT COUNT(*)::int AS c FROM users
           WHERE is_banned = TRUE
              OR (banned_until IS NOT NULL AND banned_until > NOW())`,
        ),
        query(
          `SELECT a.action, a.target_label, a.created_at, u.username AS admin_username
           FROM admin_audit_log a
           LEFT JOIN users u ON u.id = a.admin_id
           WHERE a.action IN (
             'ban', 'unban', 'unlock_login', 'revoke_sessions',
             'maintenance_on', 'maintenance_off',
             'retention_run'
           )
           ORDER BY a.created_at DESC
           LIMIT 15`,
        ).catch(() => ({ rows: [] })),
        query(`SELECT COUNT(*)::int AS c FROM users WHERE deleted_at IS NULL`).catch(
          () => ({ rows: [{ c: 0 }] }),
        ),
      ]);

      const lockedUsers = lockedR.rows || [];
      res.json({
        ok: true,
        ts: new Date().toISOString(),
        maintenance: {
          enabled: envOn || dbOn,
          envForced: envOn,
          dbEnabled: dbOn,
          message:
            maintMsg ||
            process.env.MAINTENANCE_MESSAGE ||
            null,
          source: envOn ? "env" : dbOn ? "db" : "off",
        },
        locks: {
          count: lockedUsers.length,
          users: lockedUsers,
        },
        bans: {
          count: (bannedR.rows[0] && bannedR.rows[0].c) || 0,
        },
        users: {
          activeApprox: (usersR.rows[0] && usersR.rows[0].c) || 0,
        },
        loginPolicy: {
          maxFailures: Number(process.env.LOGIN_MAX_FAILURES || 8) || 8,
          lockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15) || 15,
          ipDelayBaseMs: Number(process.env.LOGIN_IP_DELAY_BASE_MS || 250) || 250,
          ipDelayMaxMs: Number(process.env.LOGIN_IP_DELAY_MAX_MS || 8000) || 8000,
        },
        recentSecurityAudit: auditR.rows || [],
      });
    } catch (e) {
      console.error("[admin security-overview]", e);
      res.status(500).json({ error: e.message || "Özet alınamadı" });
    }
  });


  // ============================================================
  // Tüm oturumları iptal (token_version++)
  // POST /api/admin/revoke-sessions  { target }
  // ============================================================
  router.post("/revoke-sessions", isAdmin, async (req, res) => {
    try {
      const target = (req.body && (req.body.target || req.body.username)) || "";
      const user = await findUser(target);
      if (!user) return res.status(404).json({ error: "Kullanıcı bulunamadı" });

      const { rows } = await query(
        `UPDATE users
         SET token_version = COALESCE(token_version, 0) + 1
         WHERE id = $1
         RETURNING token_version`,
        [user.id],
      );
      const tv = rows[0] ? Number(rows[0].token_version) : null;

      try {
        await query(
          `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            user.id,
            "admin_revoke_sessions",
            "Admin tüm oturumları iptal etti",
            req.user && (req.user.id || req.user.sub),
            JSON.stringify({ token_version: tv }),
          ],
        );
      } catch (_) {}

      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: "revoke_sessions",
        targetUserId: user.id,
        targetLabel: user.username,
        details: { token_version: tv },
        ip: clientIp(req),
      });

      let disconnected = 0;
      try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          disconnected = global.__emDisconnectUserSockets(user.id, "TOKEN_REVOKED") || 0;
        }
      } catch (_) {}
      res.json({
        ok: true,
        success: true,
        username: user.username,
        token_version: tv,
        socketsDisconnected: disconnected,
        message: user.username + " için tüm oturumlar iptal edildi",
      });
    } catch (e) {
      console.error("[admin revoke-sessions]", e);
      res.status(500).json({ error: e.message || "Oturum iptali başarısız" });
    }
  });


  // ============================================================
  // Çevrimiçi kullanıcılar (Socket.IO)
  // GET /api/admin/online-users
  // ============================================================
  router.get("/online-users", isAdmin, async (req, res) => {
    try {
      const getIo =
        typeof global.__emGetIo === "function" ? global.__emGetIo : null;
      const io = getIo ? getIo() : null;
      if (!io) {
        return res.json({ ok: true, users: [], count: 0, note: "Socket.IO yok" });
      }
      const byUser = new Map();
      for (const [, sock] of io.of("/").sockets) {
        if (!sock.user || !sock.user.id) continue;
        const id = String(sock.user.id);
        let row = byUser.get(id);
        if (!row) {
          row = {
            userId: sock.user.id,
            username: sock.user.username || null,
            clubId: sock.user.clubId || null,
            sockets: 0,
            socketIds: [],
          };
          byUser.set(id, row);
        }
        row.sockets += 1;
        if (row.socketIds.length < 5) row.socketIds.push(sock.id);
      }
      const users = Array.from(byUser.values()).sort((a, b) =>
        String(a.username || "").localeCompare(String(b.username || ""), "tr"),
      );
      res.json({
        ok: true,
        count: users.length,
        socketCount: users.reduce((n, u) => n + u.sockets, 0),
        users,
      });
    } catch (e) {
      console.error("[admin online-users]", e);
      res.status(500).json({ error: e.message || "Liste alınamadı" });
    }
  });


  // ============================================================
  // Anlık duyuru (tüm socket istemcileri)
  // POST /api/admin/announce  { message, level?: "info"|"warn"|"urgent" }
  // ============================================================
  router.post("/announce", isAdmin, async (req, res) => {
    try {
      const message = String((req.body && req.body.message) || "")
        .trim()
        .slice(0, 400);
      if (!message || message.length < 2) {
        return res.status(400).json({ error: "Mesaj gerekli (en az 2 karakter)" });
      }
      let level = String((req.body && req.body.level) || "info").toLowerCase();
      if (["info", "warn", "urgent"].indexOf(level) < 0) level = "info";

      const getIo =
        typeof global.__emGetIo === "function" ? global.__emGetIo : null;
      const io = getIo ? getIo() : null;
      if (!io) {
        return res.status(503).json({ error: "Socket.IO hazır değil" });
      }

      const payload = {
        message,
        level,
        ts: new Date().toISOString(),
        from: "admin",
      };
      io.emit("admin:announce", payload);

      let recipients = 0;
      try {
        recipients = io.of("/").sockets.size || 0;
      } catch (_) {}

      await writeAdminAudit({
        adminId: req.user && (req.user.id || req.user.sub),
        action: "announce",
        targetUserId: null,
        targetLabel: "broadcast",
        details: { message, level, recipients },
        ip: clientIp(req),
      });

      res.json({
        ok: true,
        message,
        level,
        recipients,
      });
    } catch (e) {
      console.error("[admin announce]", e);
      res.status(500).json({ error: e.message || "Duyuru gönderilemedi" });
    }
  });

  return router;
}

module.exports = { createAdminCompatRouter };
