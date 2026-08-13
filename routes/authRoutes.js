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
const { query, withTransaction } = require("../db");
const clubsRepo = require("../repos/clubsRepo");

// GÜVENLİK: sabit/varsayılan bir JWT secret ile prod'a çıkmak, bu dosyayı
// gören (repo erişimi olan) herkesin istediği kullanıcı/admin adına geçerli
// token üretebilmesi demektir. Bu yüzden burada asla hardcoded bir fallback
// kullanılmaz; env değişkeni yoksa uygulama güvenli şekilde başlamayı reddeder.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    "JWT_SECRET ortam değişkeni tanımlı değil. Güvenlik nedeniyle sabit bir " +
      "varsayılan secret KULLANILMIYOR — lütfen .env dosyasına güçlü, rastgele " +
      "bir JWT_SECRET ekleyin (ör. `openssl rand -hex 32`).",
  );
}
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const BCRYPT_ROUNDS = 10;

// Kullanıcı bulunamadığında bile bcrypt.compare çalıştırmak için sabit bir
// "dummy" hash. Böylece "kullanıcı yok" ile "şifre yanlış" yanıtları arasında
// zamanlama farkı oluşmaz (username enumeration'a karşı).
const DUMMY_PASSWORD_HASH =
  "$2a$10$CwTycUXWue0Thq9StjUM0uJ8Y6vTvvpUseTvv8h5DIYszM.b7kNwe";

// ------------------------------------------------------------
// Basit in-memory rate limiter (login / reset-password / security-question).
// Not: tek process için yeterli; birden fazla instance/cluster ile
// çalışıyorsanız bunun yerine Redis tabanlı bir limiter (ör. rate-limiter-flexible)
// veya express-rate-limit + shared store kullanın.
// ------------------------------------------------------------
const _rateBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const rec = _rateBuckets.get(key);
  if (!rec || now - rec.start > windowMs) {
    _rateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > max;
}
// Bucket map'in süresiz büyümesini önlemek için basit periyodik temizlik.
setInterval(
  () => {
    const now = Date.now();
    for (const [k, rec] of _rateBuckets) {
      if (now - rec.start > 30 * 60 * 1000) _rateBuckets.delete(k);
    }
  },
  10 * 60 * 1000,
).unref?.();

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
    // Ban kontrolü (süreli ban otomatik kalkar)
    const { getBanStatus } = require("../adminAntiCheatRoutes");
    getBanStatus(req.user.id)
      .then((ban) => {
        if (ban && ban.banned) {
          return res.status(403).json({
            error: ban.reason || "Hesap askıya alınmış",
            code: "BANNED",
            until: ban.until || null,
          });
        }
        next();
      })
      .catch(() => next());
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

/** UUID'den stabil görünen üye no (U10000–U99999) */
function userNoFromId(id) {
  const s = String(id || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 10000 + (h >>> 0) % 90000;
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    userNo: row.user_no != null ? Number(row.user_no) : userNoFromId(row.id),
    email: row.email || null,
    createdAt: row.created_at || null,
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

  // POST /api/auth/register  { username, password, email?, teamName?, securityQuestion, securityAnswer }
  router.post("/register", async (req, res) => {
    try {
      const username = String((req.body && req.body.username) || "")
        .trim()
        .slice(0, 32);
      const password = String((req.body && req.body.password) || "");
      let email = (req.body && req.body.email
        ? String(req.body.email).trim().toLowerCase().slice(0, 255)
        : "") || "";
      if (!email) email = null;
      const teamName = (req.body && req.body.teamName
        ? String(req.body.teamName).trim().slice(0, 64)
        : null) || null;
      const securityQuestion = (req.body && req.body.securityQuestion
        ? String(req.body.securityQuestion).trim().slice(0, 120)
        : null) || null;
      const securityAnswerRaw = (req.body && req.body.securityAnswer
        ? String(req.body.securityAnswer).trim()
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
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Geçerli bir e-posta gir" });
      }
      if (!securityQuestion || securityQuestion.length < 5) {
        return res.status(400).json({
          error: "Şifre kurtarma için güvenlik sorusu gerekli (en az 5 karakter)",
        });
      }
      if (!securityAnswerRaw || securityAnswerRaw.length < 2) {
        return res.status(400).json({
          error: "Güvenlik sorusu cevabı gerekli",
        });
      }
      // GÜVENLİK: teamName burada reddedilmezse HTML/script içerebilir ve
      // sıralama, fikstür, transfer pazarı gibi onlarca ekranda başka
      // kullanıcıların tarayıcısında kaçışsız (unescaped) gösteriliyor —
      // bu yüzden kayıt anında whitelist ile engellenir (stored XSS önlemi).
      if (teamName && !/^[a-zA-Z0-9 _.\-ğüşıöçĞÜŞİÖÇ]+$/.test(teamName)) {
        return res.status(400).json({
          error: "Takım adı sadece harf, rakam, boşluk, . _ - karakterlerini içerebilir",
        });
      }

      const { SUPPORTED_COUNTRIES, DEFAULT_COUNTRY, isSupportedCountry } =
        require("../countries");
      const country = (req.body && req.body.country
        ? String(req.body.country).trim()
        : "") || DEFAULT_COUNTRY;
      if (!isSupportedCountry(country)) {
        return res.status(400).json({
          error: "Geçersiz ülke seçimi",
          supportedCountries: SUPPORTED_COUNTRIES,
        });
      }

      const existing = await query(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      if (existing.rows.length) {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }
      if (email) {
        const em = await query(
          `SELECT id FROM users WHERE email IS NOT NULL AND LOWER(email) = LOWER($1)`,
          [email],
        );
        if (em.rows.length) {
          return res.status(409).json({ error: "Bu e-posta zaten kayıtlı" });
        }
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const securityAnswerHash = await bcrypt.hash(
        securityAnswerRaw.toLowerCase(),
        BCRYPT_ROUNDS,
      );

      // Seçilen ülkenin 1. ligi 10 takıma tamamlanır (eksikse botlarla
      // doldurulur) — yeni kullanıcı bu botlardan birini devralacak.
      const botClubs = require("../botClubs");
      let leagueFill = null;
      try {
        leagueFill = await botClubs.ensureLeagueFilled({
          country,
          division: 1,
          targetSize: 10,
          generateFixtures: true,
          forceFixtures: false,
          startAt: new Date(Date.now() + 2 * 60 * 1000),
          intervalHours: 3,
        });
      } catch (e) {
        console.warn("[auth/register] league fill", e.message);
      }

      const result = await withTransaction(async (client) => {
        // GÜVENLİK: FOR UPDATE SKIP LOCKED — aynı anda kayıt olan iki
        // kullanıcının aynı bot kulübü almasını (race condition) önler.
        const botPick = await client.query(
          `SELECT id FROM clubs
           WHERE country = $1 AND division = 1
             AND is_bot = TRUE AND user_id IS NULL
           ORDER BY random()
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
          [country],
        );

        const userIns = await client.query(
          `INSERT INTO users (username, email, password_hash, security_question, security_answer_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, username, email, created_at`,
          [username, email, passwordHash, securityQuestion, securityAnswerHash],
        );
        const user = userIns.rows[0];

        let clubId;
        let tookOverBot = false;

        if (botPick.rows.length) {
          // Mevcut bot takımını kullanıcıya devret (kadro/stadyum/kulüp
          // ismi olduğu gibi kalır — "bot takımı verildi").
          clubId = botPick.rows[0].id;
          await client.query(
            `UPDATE clubs SET user_id = $1, is_bot = FALSE, updated_at = NOW()
             WHERE id = $2`,
            [user.id, clubId],
          );
          tookOverBot = true;
        } else {
          // Beklenmeyen durum: seçilen ülkenin ligi 10/10 dolu (hepsi
          // insan) — devralınacak bot yok. Sıfırdan yeni kulüp aç.
          const reg = await client.query(
            `SELECT * FROM register_new_club($1::uuid, $2::text, $3::text, $4::text)`,
            [user.id, username, teamName, country],
          );
          clubId = reg.rows[0] && reg.rows[0].club_id;
        }

        const clubRes = await client.query(
          `SELECT id, name, country, division, balance FROM clubs WHERE id = $1`,
          [clubId],
        );

        return { user, club: clubRes.rows[0] || null, tookOverBot };
      });

      const token = signToken({
        sub: result.user.id,
        username: result.user.username,
        clubId: result.club ? result.club.id : null,
      });

      res.status(201).json({
        token,
        user: publicUser(result.user),
        club: publicClub(result.club),
        tookOverBot: result.tookOverBot,
        leagueFill,
      });
    } catch (e) {
      console.error("[auth/register]", e);
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }
      // GÜVENLİK: iç hata mesajı (SQL/şema detayları vb.) client'a sızdırılmaz;
      // teşhis için tüm detay yukarıdaki console.error ile sunucu logunda tutulur.
      res.status(500).json({ error: "Kayıt başarısız. Lütfen tekrar dene." });
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

      // Kaba kuvvet (brute-force) girişimlerine karşı IP başına sınır.
      const rlKey = "login:" + (req.ip || "unknown");
      if (rateLimited(rlKey, 15, 15 * 60 * 1000)) {
        return res.status(429).json({
          error: "Çok fazla giriş denemesi. Lütfen birkaç dakika sonra tekrar dene.",
        });
      }

      const { rows } = await query(
        `SELECT id, username, email, created_at, password_hash, is_banned, banned_until, ban_reason
         FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];

      // Kullanıcı bulunamasa bile bcrypt.compare çalıştırılır (dummy hash ile);
      // aksi halde "kullanıcı yok" yanıtı belirgin şekilde daha hızlı döner ve
      // bu zamanlama farkı username enumeration için kullanılabilir.
      const ok = await bcrypt.compare(
        password,
        user ? user.password_hash : DUMMY_PASSWORD_HASH,
      );
      if (!user || !ok) {
        return res.status(401).json({ error: "Hatalı kullanıcı adı veya şifre" });
      }

      if (user.is_banned) {
        // Süreli ban dolmuş mu?
        if (user.banned_until && new Date(user.banned_until).getTime() <= Date.now()) {
          await query(
            `UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL,
               banned_at = NULL, banned_by = NULL WHERE id = $1`,
            [user.id],
          );
        } else {
          const reason = user.ban_reason || "Kural ihlali";
          let untilStr = "";
          if (user.banned_until) {
            try {
              untilStr =
                " Ban bitiş: " +
                new Date(user.banned_until).toLocaleString("tr-TR");
            } catch (_) {}
          }
          return res.status(403).json({
            error:
              "Hesabınız banlandı. Sebep: " + reason + "." + untilStr,
            code: "BANNED",
            until: user.banned_until || null,
            reason: reason,
          });
        }
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
      // GÜVENLİK: iç hata mesajı (SQL/şema detayları vb.) client'a sızdırılmaz;
      // tüm detay yalnızca sunucu logunda tutulur.
      res.status(500).json({ error: "Giriş başarısız. Lütfen tekrar dene." });
    }
  });

  // GET /api/auth/security-question?username=...  (herkese açık)
  router.get("/security-question", async (req, res) => {
    try {
      const username = String((req.query && req.query.username) || "").trim();
      if (!username) return res.status(400).json({ error: "Kullanıcı adı gerekli" });
      const rlKey = "secq:" + (req.ip || "unknown");
      if (rateLimited(rlKey, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: "Çok fazla deneme. Birkaç dakika sonra tekrar dene." });
      }
      const { rows } = await query(
        `SELECT security_question FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      if (!rows[0] || !rows[0].security_question) {
        return res
          .status(404)
          .json({ error: "Bu hesap için güvenlik sorusu tanımlı değil. Admin ile iletişime geç." });
      }
      res.json({ question: rows[0].security_question });
    } catch (e) {
      console.error("[auth/security-question]", e);
      res.status(500).json({ error: "Sorgu başarısız" });
    }
  });

  // POST /api/auth/reset-password  { username, answer, newPassword }  (herkese açık)
  router.post("/reset-password", async (req, res) => {
    try {
      const username = String((req.body && req.body.username) || "").trim();
      const answer = String((req.body && req.body.answer) || "").trim().toLowerCase();
      const newPassword = String((req.body && req.body.newPassword) || "");
      if (!username || !answer || !newPassword) {
        return res.status(400).json({ error: "Tüm alanlar gerekli" });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Yeni şifre en az 6 karakter olmalı" });
      }
      // Güvenlik sorusu cevapları genelde şifreden düşük entropiye sahiptir
      // (ör. "forma numarası") — bu uç kaba kuvvet denemesine karşı sıkı sınırlanır.
      const rlKey = "reset:" + (req.ip || "unknown") + ":" + username.toLowerCase();
      if (rateLimited(rlKey, 5, 15 * 60 * 1000)) {
        return res.status(429).json({
          error: "Çok fazla deneme. Lütfen birkaç dakika sonra tekrar dene.",
        });
      }
      const { rows } = await query(
        `SELECT id, security_answer_hash FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      if (!user || !user.security_answer_hash) {
        return res.status(404).json({ error: "Bu hesap için güvenlik sorusu tanımlı değil" });
      }
      const ok = await bcrypt.compare(answer, user.security_answer_hash);
      if (!ok) {
        return res.status(401).json({ error: "Cevap yanlış" });
      }
      const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
        user.id,
        newHash,
      ]);
      res.json({ ok: true });
    } catch (e) {
      console.error("[auth/reset-password]", e);
      res.status(500).json({ error: "Sıfırlama başarısız" });
    }
  });

  // Hesabı kalıcı sil — YALNIZCA admin (kendi veya targetUsername)
  router.post("/delete-account", authMiddleware, async (req, res) => {
    try {
      const { isAdmin } = require("../nationalSystem");
      if (!isAdmin(req.user && req.user.username)) {
        return res
          .status(403)
          .json({ ok: false, error: "Yalnızca admin hesap silebilir" });
      }
      const targetUsername = String(
        (req.body && req.body.targetUsername) || "",
      ).trim();
      let userId = req.user && req.user.id;
      let deletedUsername = req.user && req.user.username;
      if (targetUsername) {
        const { rows } = await query(
          `SELECT id, username FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
          [targetUsername],
        );
        if (!rows.length) {
          return res
            .status(404)
            .json({ ok: false, error: "Kullanıcı bulunamadı" });
        }
        userId = rows[0].id;
        deletedUsername = rows[0].username;
      }
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });

      await withTransaction(async (client) => {
        const soft = async (sql, params) => {
          try {
            await client.query(sql, params);
          } catch (_) {}
        };
        // Kulüp bağını çöz
        await soft(`UPDATE clubs SET user_id = NULL WHERE user_id = $1`, [
          userId,
        ]);
        await soft(
          `UPDATE national_teams SET manager_user_id = NULL, manager_club_id = NULL WHERE manager_user_id = $1`,
          [userId],
        );
        await soft(
          `DELETE FROM national_manager_applications WHERE user_id = $1`,
          [userId],
        );
        await soft(`DELETE FROM elite_subscriptions WHERE user_id = $1`, [
          userId,
        ]);
        await soft(`DELETE FROM elite_payments WHERE user_id = $1`, [userId]);
        await soft(`DELETE FROM messages WHERE from_user_id = $1 OR to_user_id = $1`, [
          userId,
        ]);
        await soft(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
        await soft(`DELETE FROM forum_posts WHERE user_id = $1`, [userId]);
        await soft(`DELETE FROM anti_cheat_log WHERE user_id = $1`, [userId]);
        await soft(`DELETE FROM transfer_bids WHERE bidder_user_id = $1`, [
          userId,
        ]);
        await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
      });
      res.json({ ok: true, deletedUsername });
    } catch (e) {
      console.error("[auth/delete-account]", e);
      res.status(500).json({ ok: false, error: "Hesap silinemedi" });
    }
  });

  return router;
}

/**
 * POST /api/auth/admin-reset-password  { targetUsername, newPassword }
 * authMiddleware ile korunur; sadece .env ADMIN_USERNAME hesabı kullanabilir.
 * Güvenlik sorusu tanımlamamış eski hesaplar (ör. demo admin) için son çare.
 */
async function adminResetPasswordHandler(req, res) {
  try {
    const { isAdmin } = require("../nationalSystem");
    if (!isAdmin(req.user.username)) {
      return res.status(403).json({ error: "Bu işlem için yetkin yok" });
    }
    const targetUsername = String((req.body && req.body.targetUsername) || "").trim();
    const newPassword = String((req.body && req.body.newPassword) || "");
    if (!targetUsername || newPassword.length < 6) {
      return res.status(400).json({ error: "Kullanıcı adı ve en az 6 karakterlik yeni şifre gerekli" });
    }
    const { rows } = await query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
      [targetUsername],
    );
    if (!rows[0]) return res.status(404).json({ error: "Kullanıcı bulunamadı" });
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
      rows[0].id,
      newHash,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[auth/admin-reset-password]", e);
    res.status(500).json({ error: "Sıfırlama başarısız" });
  }
}

/** GET /api/me — authMiddleware ile korunmalı */
async function meHandler(req, res) {
  try {
    await enrichClubId(req);
    const { rows } = await query(
      `SELECT id, username, email, created_at FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Kullanıcı yok" });
    const club = await clubsRepo.getClubByUserId(req.user.id);
    let elite = { active: false, plan: null, until: null, trial: false };
    try {
      const premiumSystem = require("../premiumSystem");
      await premiumSystem.ensureTrial(req.user.id);
      elite = await premiumSystem.getStatus(req.user.id);
    } catch (e) {
      console.warn("[me] elite", e.message);
    }
    const user = publicUser(rows[0]);
    res.json({
      user,
      club: publicClub(club),
      elite,
      account: {
        userNo: user.userNo,
        hasEmail: !!rows[0].email,
        hasSecurityQuestion: true,
        createdAt: rows[0].created_at,
      },
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
  adminResetPasswordHandler,
  socketAuthMiddleware,
  enrichClubId,
  signToken,
  JWT_SECRET,
};
