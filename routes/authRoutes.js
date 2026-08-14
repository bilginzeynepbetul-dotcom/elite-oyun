// ============================================================
// routes/authRoutes.js — Kayıt / giriş / refresh / şifre sıfırlama
// ------------------------------------------------------------
//   const { createAuthRouter, enrichClubId, signToken, userNoFromId } =
//     require("./routes/authRoutes");
// ============================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const clubsRepo = require("../repos/clubsRepo");
const { userNoFromId } = require("../managerProfile");
const antiCheat = require("../antiCheat");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET ortam değişkeni tanımlı değil. Güvenlik nedeniyle sabit bir " +
      "varsayılan secret KULLANILMIYOR — lütfen .env dosyasına güçlü, rastgele " +
      "bir JWT_SECRET ekleyin (ör. `openssl rand -hex 32`).",
  );
}

const ACCESS_EXPIRES =
  process.env.JWT_ACCESS_EXPIRES || process.env.JWT_EXPIRES || "2h";
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES || "30d";

/** IP tabanlı rate limit — auth uçları için */
function clientKey(req) {
  return (
    (req.headers["x-forwarded-for"] &&
      String(req.headers["x-forwarded-for"]).split(",")[0].trim()) ||
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    "unknown"
  );
}

function authRateLimit(req, res, action, max, windowMs) {
  const key = "auth:" + action + ":" + clientKey(req);
  const r = antiCheat.rateLimit(key, max, windowMs);
  if (!r.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil((r.retryAfterMs || 1000) / 1000)),
    );
    res.status(429).json(r);
    return false;
  }
  return true;
}


function signAccessToken(user, clubId) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      clubId: clubId || null,
      typ: "access",
    },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES },
  );
}

function signRefreshToken(user, clubId) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      clubId: clubId || null,
      typ: "refresh",
    },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES },
  );
}

function signToken(user, clubId) {
  return signAccessToken(user, clubId);
}

function parseExpiresSec(exp) {
  if (!exp) return 7200;
  const m = String(exp).match(/^(\d+)([smhd])$/i);
  if (!m) return 7200;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u === "s") return n;
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  if (u === "d") return n * 86400;
  return 7200;
}

function clubPublic(club) {
  if (!club) return null;
  return {
    id: club.id,
    name: club.name,
    country: club.country,
    division: club.division,
    balance: Number(club.balance) || 0,
    isBot: !!club.is_bot,
  };
}

function userPublic(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || null,
    userNo: userNoFromId(user.id),
  };
}

function tokenPair(user, clubId) {
  const accessToken = signAccessToken(user, clubId);
  const refreshToken = signRefreshToken(user, clubId);
  return {
    token: accessToken,
    accessToken,
    refreshToken,
    expiresIn: parseExpiresSec(ACCESS_EXPIRES),
  };
}

/**
 * req.user.clubId yoksa DB'den doldurur (token eskiyse).
 * Birçok route bu helper'ı kullanır.
 */
async function enrichClubId(req) {
  if (req.user && req.user.clubId) return req.user.clubId;
  const userId = req.user && (req.user.id || req.user.userId || req.user.sub);
  if (!userId) return null;
  try {
    const club = await clubsRepo.getClubByUserId(userId);
    if (club && club.id) {
      if (req.user) req.user.clubId = club.id;
      return club.id;
    }
  } catch (e) {
    console.warn("[enrichClubId]", e.message);
  }
  return null;
}

function getClubIdFromReq(req) {
  return (req.user && req.user.clubId) || null;
}

function createAuthRouter() {
  const router = express.Router();

  // POST /api/auth/register
  router.post("/register", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "register", 5, 900000)) return;
      const username = String((req.body && req.body.username) || "")
        .trim()
        .slice(0, 32);
      const password = String((req.body && req.body.password) || "");
      const emailRaw = (req.body && req.body.email) || null;
      const email = emailRaw ? String(emailRaw).trim().slice(0, 255) : null;
      const teamName = (req.body && req.body.teamName) || null;
      const country =
        String((req.body && req.body.country) || "Türkiye").trim() ||
        "Türkiye";
      const securityQuestion = String(
        (req.body && req.body.securityQuestion) || "",
      ).trim();
      const securityAnswer = String(
        (req.body && req.body.securityAnswer) || "",
      ).trim();

      if (!username || username.length < 3) {
        return res
          .status(400)
          .json({ error: "Kullanıcı adı en az 3 karakter olmalı" });
      }
      if (!password || password.length < 8) {
        return res
          .status(400)
          .json({ error: "Şifre en az 8 karakter olmalı" });
      }
      if (password.length > 128) {
        return res.status(400).json({ error: "Şifre çok uzun" });
      }
      if (!securityQuestion || securityQuestion.length < 5) {
        return res
          .status(400)
          .json({ error: "Güvenlik sorusu zorunlu (en az 5 karakter)" });
      }
      if (!securityAnswer || securityAnswer.length < 2) {
        return res
          .status(400)
          .json({ error: "Güvenlik sorusu cevabı zorunlu" });
      }

      const existing = await db.query(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      if (existing.rows.length) {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }
      if (email) {
        const em = await db.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
          [email],
        );
        if (em.rows.length) {
          return res.status(409).json({ error: "Bu e-posta kayıtlı" });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const answerHash = await bcrypt.hash(
        securityAnswer.toLowerCase().trim(),
        10,
      );

      const { rows: userRows } = await db.query(
        `INSERT INTO users (username, password_hash, email, security_question, security_answer_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, email, created_at`,
        [username, passwordHash, email, securityQuestion, answerHash],
      );
      const user = userRows[0];

      // register_new_club SQL fonksiyonu (migration 020)
      let clubId = null;
      let club = null;
      try {
        const { rows: regRows } = await db.query(
          `SELECT club_id, season_id FROM register_new_club($1, $2, $3, $4)`,
          [user.id, username, teamName || username + " SK", country],
        );
        clubId = regRows[0] && regRows[0].club_id;
      } catch (eReg) {
        console.error("[auth/register] register_new_club", eReg.message);
        // Fallback: minimal club insert
        const { rows: cRows } = await db.query(
          `INSERT INTO clubs (user_id, name, country, division, balance)
           VALUES ($1, $2, $3, 1, 5000000)
           RETURNING *`,
          [user.id, teamName || username + " SK", country],
        );
        clubId = cRows[0] && cRows[0].id;
        club = cRows[0];
      }
      if (!club && clubId) {
        club = await clubsRepo.getClub(clubId);
      }

      await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
        user.id,
      ]);

      // Lig bot + fikstür — kayıt yanıtından ÖNCE hazır olsun
      try {
        const botClubs = require("../botClubs");
        const leagueRepo = require("../repos/leagueRepo");
        const ctry = (club && club.country) || country || "Türkiye";
        const div = (club && club.division) || 1;
        await botClubs.ensureLeagueFilled({
          country: ctry,
          division: div,
          targetSize: 8,
          generateFixtures: true,
        });
        // Yeni kulüp fikstüre girmemişse (mevcut fikstür varken skip oluyordu) yenile
        if (clubId) {
          const next = await leagueRepo.getNextFixtureForClub(clubId);
          if (!next) {
            const season = await leagueRepo.ensureSeason(ctry, div);
            if (season) {
              await leagueRepo.ensureClubInStandings(season.id, clubId);
              await leagueRepo.generateFixturesForSeason(season.id, {
                force: true,
              });
            }
          }
        }
      } catch (eFill) {
        console.warn("[auth/register] fill bots", eFill.message);
      }

      const tokens = tokenPair(user, clubId);
      res.status(201).json({
        ...tokens,
        user: userPublic(user),
        club: clubPublic(club),
      });
    } catch (e) {
      console.error("[auth/register]", e);
      res.status(500).json({ error: "Kayıt başarısız" });
    }
  });

  // POST /api/auth/login
  router.post("/login", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "login", 12, 900000)) return;
      const username = String((req.body && req.body.username) || "").trim();
      const password = String((req.body && req.body.password) || "");
      if (!username || !password) {
        return res.status(400).json({ error: "Kullanıcı adı ve şifre gerekli" });
      }

      const { rows } = await db.query(
        `SELECT id, username, email, password_hash, is_banned, banned_until, ban_reason
         FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      if (!user) {
        return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
      }

      if (user.is_banned) {
        const until = user.banned_until ? new Date(user.banned_until) : null;
        if (!until || until > new Date()) {
          return res.status(403).json({
            error: "Hesabınız engellenmiş",
            code: "BANNED",
            banned_until: user.banned_until,
            reason: user.ban_reason,
          });
        }
      }

      const club = await clubsRepo.getClubByUserId(user.id);
      const clubId = club ? club.id : null;

      await db.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [
        user.id,
      ]);

      const tokens = tokenPair(user, clubId);
      res.json({
        ...tokens,
        user: userPublic(user),
        club: clubPublic(club),
      });
    } catch (e) {
      console.error("[auth/login]", e);
      res.status(500).json({ error: "Giriş başarısız" });
    }
  });

  // POST /api/auth/refresh
  router.post("/refresh", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "refresh", 30, 15 * 60 * 1000)) return;
      const refreshToken =
        (req.body && req.body.refreshToken) ||
        req.headers["x-refresh-token"] ||
        null;
      if (!refreshToken) {
        return res.status(400).json({ error: "refreshToken gerekli" });
      }

      let decoded;
      try {
        decoded = jwt.verify(refreshToken, JWT_SECRET);
      } catch (e) {
        return res.status(401).json({ error: "Geçersiz veya süresi dolmuş refresh token" });
      }
      if (decoded.typ !== "refresh") {
        return res.status(401).json({
          error: "Refresh token gerekli",
          code: "REFRESH_REQUIRED",
        });
      }

      const userId = decoded.sub;
      const { rows } = await db.query(
        `SELECT id, username, email, is_banned, banned_until, ban_reason
         FROM users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      if (!user) {
        return res.status(401).json({ error: "Kullanıcı bulunamadı" });
      }
      if (user.is_banned) {
        const until = user.banned_until ? new Date(user.banned_until) : null;
        if (!until || until > new Date()) {
          return res.status(403).json({
            error: "Hesabınız engellenmiş",
            code: "BANNED",
          });
        }
      }

      const club = await clubsRepo.getClubByUserId(user.id);
      const clubId = (club && club.id) || decoded.clubId || null;
      const tokens = tokenPair(user, clubId);
      res.json({
        ...tokens,
        user: userPublic(user),
        club: clubPublic(club),
      });
    } catch (e) {
      console.error("[auth/refresh]", e);
      res.status(500).json({ error: "Token yenilenemedi" });
    }
  });

  // GET /api/auth/security-question?username=
  router.get("/security-question", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "security-question", 10, 15 * 60 * 1000)) return;
      const username = String(req.query.username || "").trim();
      if (!username) {
        return res.status(400).json({ error: "username gerekli" });
      }
      const { rows } = await db.query(
        `SELECT security_question FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      if (!rows[0] || !rows[0].security_question) {
        return res.status(404).json({ error: "Kullanıcı veya soru bulunamadı" });
      }
      res.json({ question: rows[0].security_question });
    } catch (e) {
      console.error("[auth/security-question]", e);
      res.status(500).json({ error: "Soru alınamadı" });
    }
  });

  // POST /api/auth/reset-password  { username, answer, newPassword }
  router.post("/reset-password", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "reset-password", 5, 900000)) return;
      const username = String((req.body && req.body.username) || "").trim();
      const answer = String((req.body && req.body.answer) || "").trim();
      const newPassword = String((req.body && req.body.newPassword) || "");
      if (!username || !answer || !newPassword || newPassword.length < 8) {
        return res.status(400).json({
          error: "username, answer ve newPassword (min 8) gerekli",
        });
      }
      if (newPassword.length > 128) {
        return res.status(400).json({ error: "Şifre çok uzun" });
      }
      const { rows } = await db.query(
        `SELECT id, security_answer_hash FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      if (!user || !user.security_answer_hash) {
        return res.status(404).json({ error: "Kullanıcı veya güvenlik cevabı yok" });
      }
      const ok = await bcrypt.compare(
        answer.toLowerCase().trim(),
        user.security_answer_hash,
      );
      if (!ok) {
        return res.status(403).json({ error: "Güvenlik cevabı hatalı" });
      }
      const hash = await bcrypt.hash(newPassword, 10);
      await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
        hash,
        user.id,
      ]);
      res.json({ ok: true, message: "Şifre sıfırlandı" });
    } catch (e) {
      console.error("[auth/reset-password]", e);
      res.status(500).json({ error: "Sıfırlama başarısız" });
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
  enrichClubId,
  getClubIdFromReq,
  signToken,
  signAccessToken,
  signRefreshToken,
  userNoFromId,
  tokenPair,
  clubPublic,
  userPublic,
};
