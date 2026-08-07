// ============================================================
// authRoutes.js — Kayıt / Giriş / Me (PostgreSQL + JWT)
// ------------------------------------------------------------
// Bağımlılıklar: pg (db.js), bcryptjs, jsonwebtoken
//
//   const { createAuthRouter, authMiddleware } = require("./authRoutes");
//   app.use("/api/auth", createAuthRouter());
//   app.get("/api/me", authMiddleware, meHandler);
//
// Env:
//   JWT_SECRET=...
//   JWT_EXPIRES=7d
// ============================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { query, withTransaction } = require("./db");
const clubsRepo = require("./repos/clubsRepo");

const JWT_SECRET = process.env.JWT_SECRET || "em-dev-secret-change-me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const BCRYPT_ROUNDS = 10;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Token gerekli" });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      username: decoded.username,
      clubId: decoded.clubId || null,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Geçersiz veya süresi dolmuş token" });
  }
}

/** ClubId yoksa DB'den doldur (eski token'lar için) */
async function enrichClubId(req) {
  if (req.user.clubId) return req.user.clubId;
  const club = await clubsRepo.getClubByUserId(req.user.id);
  if (club) req.user.clubId = club.id;
  return req.user.clubId;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
  };
}

function publicClub(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    division: row.division,
    balance: Number(row.balance),
  };
}

function createAuthRouter() {
  const router = express.Router();

  // POST /api/auth/register  { username, password, teamName? }
  router.post("/register", async (req, res) => {
    try {
      const username = String((req.body && req.body.username) || "")
        .trim()
        .slice(0, 32);
      const password = String((req.body && req.body.password) || "");
      const teamName = (req.body && req.body.teamName
        ? String(req.body.teamName).trim().slice(0, 64)
        : null) || null;

      if (!username || username.length < 3) {
        return res.status(400).json({ error: "Kullanıcı adı en az 3 karakter" });
      }
      if (!/^[a-zA-Z0-9_ğüşıöçĞÜŞİÖÇ]+$/.test(username)) {
        return res
          .status(400)
          .json({ error: "Kullanıcı adı sadece harf, rakam, _ olabilir" });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ error: "Şifre en az 6 karakter olmalı" });
      }

      const existing = await query(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      if (existing.rows.length) {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const result = await withTransaction(async (client) => {
        const userIns = await client.query(
          `INSERT INTO users (username, password_hash)
           VALUES ($1, $2)
           RETURNING id, username, created_at`,
          [username, passwordHash],
        );
        const user = userIns.rows[0];

        const reg = await client.query(
          `SELECT * FROM register_new_club($1::uuid, $2::text, $3::text)`,
          [user.id, username, teamName],
        );
        const clubId = reg.rows[0] && reg.rows[0].club_id;

        const clubRes = await client.query(
          `SELECT id, name, country, division, balance FROM clubs WHERE id = $1`,
          [clubId],
        );

        return { user, club: clubRes.rows[0] || null };
      });

      const token = signToken({
        sub: result.user.id,
        username: result.user.username,
        clubId: result.club ? result.club.id : null,
      });

      // Lig seyrekse botlarla doldur + fikstür (kullanıcı beklemesin)
      let leagueFill = null;
      try {
        const botClubs = require("./botClubs");
        const c = result.club;
        leagueFill = await botClubs.ensureLeagueFilled({
          country: (c && c.country) || "Türkiye",
          division: (c && c.division) || 1,
          targetSize: 10,
          generateFixtures: true,
          forceFixtures: false,
          startAt: new Date(Date.now() + 2 * 60 * 1000),
          intervalHours: 3,
        });
      } catch (e) {
        console.warn("[auth/register] league fill", e.message);
      }

      res.status(201).json({
        token,
        user: publicUser(result.user),
        club: publicClub(result.club),
        leagueFill,
      });
    } catch (e) {
      console.error("[auth/register]", e);
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }
      // Geçici: gerçek hatayı ekranda göster (teşhis kolaylığı için).
      // Prod'a çıkarken bu satırı "Kayıt başarısız" ile değiştir.
      res.status(500).json({
        error: "Kayıt başarısız: " + (e && e.message ? e.message : "bilinmeyen hata"),
        code: e && e.code,
      });
    }
  });

  // POST /api/auth/login  { username, password }
  router.post("/login", async (req, res) => {
    try {
      const username = String((req.body && req.body.username) || "").trim();
      const password = String((req.body && req.body.password) || "");
      if (!username || !password) {
        return res.status(400).json({ error: "Kullanıcı adı ve şifre gerekli" });
      }

      const { rows } = await query(
        `SELECT id, username, password_hash, is_banned
         FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      if (!user) {
        return res.status(401).json({ error: "Hatalı kullanıcı adı veya şifre" });
      }
      if (user.is_banned) {
        return res.status(403).json({ error: "Hesap askıya alınmış" });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Hatalı kullanıcı adı veya şifre" });
      }

      await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
        user.id,
      ]);

      const club = await clubsRepo.getClubByUserId(user.id);
      const token = signToken({
        sub: user.id,
        username: user.username,
        clubId: club ? club.id : null,
      });

      res.json({
        token,
        user: publicUser(user),
        club: publicClub(club),
      });
    } catch (e) {
      console.error("[auth/login]", e);
      res.status(500).json({
        error: "Giriş başarısız: " + (e && e.message ? e.message : "bilinmeyen hata"),
        code: e && e.code,
      });
    }
  });

  return router;
}

/** GET /api/me — authMiddleware ile korunmalı */
async function meHandler(req, res) {
  try {
    await enrichClubId(req);
    const { rows } = await query(
      `SELECT id, username FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Kullanıcı yok" });
    const club = await clubsRepo.getClubByUserId(req.user.id);
    res.json({
      user: publicUser(rows[0]),
      club: publicClub(club),
    });
  } catch (e) {
    console.error("[me]", e);
    res.status(500).json({ error: "Profil alınamadı" });
  }
}

/**
 * Socket.IO auth: handshake.auth.token → socket.data.user
 *   io.use(socketAuthMiddleware)
 */
function socketAuthMiddleware(socket, next) {
  const token =
    (socket.handshake.auth && socket.handshake.auth.token) ||
    (socket.handshake.query && socket.handshake.query.token);
  if (!token) return next(new Error("auth required"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.data.user = {
      id: decoded.sub,
      username: decoded.username,
      clubId: decoded.clubId || null,
    };
    next();
  } catch (e) {
    next(new Error("invalid token"));
  }
}

module.exports = {
  createAuthRouter,
  authMiddleware,
  meHandler,
  socketAuthMiddleware,
  enrichClubId,
  signToken,
  JWT_SECRET,
};
