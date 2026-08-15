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

/** IP tabanlı rate limit — auth uçları için
 * GÜVENLİK: X-Forwarded-For client tarafından serbestçe set edilebildiği
 * için burada ASLA ham header kullanılmaz — aksi halde login/register/
 * reset-password brute-force limitleri, her istekte farklı bir sahte
 * değer göndererek trivially atlatılabilir. `app.set("trust proxy", 1)`
 * (server.js) sayesinde Express'in hesapladığı req.ip güvenilirdir. */
function clientKey(req) {
  return (
    req.ip || (req.connection && req.connection.remoteAddress) || "unknown"
  );
}

function authRateLimit(req, res, action, max, windowMs) {
  const key = "auth:" + action + ":" + clientKey(req);
  const r = antiCheat.rateLimit(key, max, windowMs);
  // Bilgi başlıkları (limit aşılsın veya aşılmasın)
  try {
    res.setHeader("X-RateLimit-Limit", String(max));
    if (r && r.retryAfterMs != null && !r.ok) {
      res.setHeader(
        "X-RateLimit-Remaining",
        "0",
      );
      res.setHeader(
        "Retry-After",
        String(Math.ceil((r.retryAfterMs || 1000) / 1000)),
      );
    }
  } catch (_) {}
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


/** JWT'ye gömülen oturum sürümü — users.token_version ile eşleşmezse token iptal */
function tokenVersionOf(user) {
  const v = user && (user.token_version ?? user.tokenVersion);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function signAccessToken(user, clubId) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      clubId: clubId || null,
      typ: "access",
      tv: tokenVersionOf(user),
    },
    JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES, algorithm: "HS256" },
  );
}

function signRefreshToken(user, clubId) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      clubId: clubId || null,
      typ: "refresh",
      tv: tokenVersionOf(user),
    },
    JWT_SECRET,
    { expiresIn: REFRESH_EXPIRES, algorithm: "HS256" },
  );
}

/** Tüm oturumları düşür (şifre değişimi / ban / logout-all) */
async function bumpTokenVersion(userId) {
  const { rows } = await db.query(
    `UPDATE users SET token_version = COALESCE(token_version, 0) + 1
     WHERE id = $1
     RETURNING token_version`,
    [userId],
  );
  return rows[0] ? Number(rows[0].token_version) : null;
}

// Şifre sıfırlama brute-force koruması (process belleği; tek instance)
const _resetFails = new Map(); // key → { count, lockedUntil }
function resetFailKey(username, ip) {
  return String(username || "").toLowerCase() + "|" + String(ip || "");
}
function checkResetLock(username, ip) {
  const k = resetFailKey(username, ip);
  const e = _resetFails.get(k);
  if (!e) return { ok: true };
  if (e.lockedUntil && Date.now() < e.lockedUntil) {
    return {
      ok: false,
      retryAfterMs: e.lockedUntil - Date.now(),
    };
  }
  if (e.lockedUntil && Date.now() >= e.lockedUntil) {
    _resetFails.delete(k);
  }
  return { ok: true };
}
function recordResetFail(username, ip) {
  const k = resetFailKey(username, ip);
  const e = _resetFails.get(k) || { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= 5) {
    e.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 dk
    e.count = 0;
  }
  _resetFails.set(k, e);
}
function clearResetFails(username, ip) {
  _resetFails.delete(resetFailKey(username, ip));
}

// ------------------------------------------------------------
// IP bazlı kademeli gecikme (login brute-force yavaşlatma)
// Hesap kilidinden bağımsız; yanlış denemelerde yanıt süresini artırır.
// ------------------------------------------------------------
const _ipLoginFails = new Map(); // ip → { count, resetAt }

function ipLoginFailKey(ip) {
  return String(ip || "unknown");
}

function getIpLoginFailCount(ip) {
  const k = ipLoginFailKey(ip);
  const e = _ipLoginFails.get(k);
  if (!e) return 0;
  if (Date.now() >= e.resetAt) {
    _ipLoginFails.delete(k);
    return 0;
  }
  return e.count || 0;
}

function recordIpLoginFail(ip) {
  const k = ipLoginFailKey(ip);
  const windowMs = Math.max(
    60_000,
    Number(process.env.LOGIN_IP_FAIL_WINDOW_MS || 900000) || 900000,
  );
  const now = Date.now();
  let e = _ipLoginFails.get(k);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + windowMs };
  }
  e.count += 1;
  _ipLoginFails.set(k, e);
  return e.count;
}

function clearIpLoginFails(ip) {
  _ipLoginFails.delete(ipLoginFailKey(ip));
}

/** Kademeli gecikme ms: base * 2^(n-1), max ile sınırlı */
function progressiveIpDelayMs(ip) {
  const n = getIpLoginFailCount(ip);
  if (n <= 0) return 0;
  const base = Math.max(
    50,
    Number(process.env.LOGIN_IP_DELAY_BASE_MS || 250) || 250,
  );
  const maxMs = Math.max(
    base,
    Number(process.env.LOGIN_IP_DELAY_MAX_MS || 8000) || 8000,
  );
  // n=1 → base, n=2 → 2*base, ...
  const exp = Math.min(n - 1, 8);
  return Math.min(maxMs, base * Math.pow(2, exp));
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

/** Güvenlik olayı webhook (Discord uyumlu) — ACCOUNT_LOCKED vb. */
function notifySecurityEvent(ev) {
  // anti_cheat_log (admin panel loglarında görünsün)
  try {
    const uid = ev && (ev.userId || ev.user_id) || null;
    if (uid) {
      db.query(
        `INSERT INTO anti_cheat_log (user_id, action, reason, admin_id, details)
         VALUES ($1, $2, $3, NULL, $4::jsonb)`,
        [
          uid,
          String((ev && ev.event) || "security_event").slice(0, 64),
          String((ev && ev.message) || "").slice(0, 240),
          JSON.stringify({
            ip: ev && ev.ip,
            lockMinutes: ev && ev.lockMinutes,
            failed_login_count: ev && ev.failed_login_count,
            username: ev && ev.username,
          }),
        ],
      ).catch(function () {});
    }
  } catch (_) {}

  const url = (
    process.env.SECURITY_WEBHOOK_URL ||
    process.env.ERROR_WEBHOOK_URL ||
    ""
  ).trim();
  if (!url) return;
  const payload = {
    source: "elite-manager-security",
    ts: new Date().toISOString(),
    ...ev,
  };
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks/i.test(url);
  const body = isDiscord
    ? {
        content: null,
        embeds: [
          {
            title: "🛡️ " + String(ev.event || "security"),
            description: String(ev.message || "").slice(0, 1500),
            color: 15105570,
            fields: [
              {
                name: "user",
                value: String(ev.username || ev.userId || "-").slice(0, 80),
                inline: true,
              },
              {
                name: "ip",
                value: String(ev.ip || "-").slice(0, 64),
                inline: true,
              },
            ],
            timestamp: payload.ts,
          },
        ],
      }
    : payload;
  Promise.resolve()
    .then(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
    .catch(() => {});
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
    lastLoginAt: user.last_login_at || user.lastLoginAt || null,
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


/**
 * Soft-delete / anonimleştirme (KVKK & GDPR).
 * fixtures / match_results clubs(id) RESTRICT bağlı → fiziksel DELETE yok.
 * - users: deleted_at, PII scrub, token_version++
 * - clubs: user_id NULL, is_bot TRUE (lig geçmişi korunur)
 * - forum / mesaj / milli takım / bağış / bildirim temizliği
 */
async function softDeleteAccount(userId, opts) {
  const { withTransaction } = require("../db");
  const requestedBy = (opts && opts.requestedBy) || userId;
  const reason = (opts && opts.reason) || "user_request";
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, username, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) {
      const err = new Error("Kullanıcı bulunamadı");
      err.status = 404;
      throw err;
    }
    if (rows[0].deleted_at) {
      const err = new Error("Hesap zaten kapatılmış");
      err.status = 409;
      throw err;
    }
    const short = String(userId).replace(/-/g, "").slice(0, 12);
    const anonUser = "deleted_" + short;
    const deadHash = await bcrypt.hash(
      "deleted-" + short + "-" + Date.now() + "-" + Math.random(),
      10,
    );

    await client.query(
      `UPDATE users SET
         username = $2,
         email = NULL,
         password_hash = $3,
         security_question = NULL,
         security_answer_hash = NULL,
         email_verify_token = NULL,
         email_verify_expires = NULL,
         email_verified_at = NULL,
         failed_login_count = 0,
         locked_until = NULL,
         deleted_at = NOW(),
         is_banned = TRUE,
         ban_reason = COALESCE(ban_reason, 'account_deleted'),
         token_version = COALESCE(token_version, 0) + 1,
         last_login_at = NULL
       WHERE id = $1`,
      [userId, anonUser, deadHash],
    );

    const { rows: clubRows } = await client.query(
      `SELECT id, name FROM clubs WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const clubIds = [];
    for (const club of clubRows) {
      clubIds.push(club.id);
      const clubName = (club.name || "Kulüp").slice(0, 48);
      const newName =
        clubName.indexOf("(kapalı)") >= 0
          ? clubName
          : (clubName + " (kapalı)").slice(0, 64);
      await client.query(
        `UPDATE clubs SET
           user_id = NULL,
           is_bot = TRUE,
           name = $2,
           updated_at = NOW()
         WHERE id = $1`,
        [club.id, newName],
      );
      try {
        await client.query(
          `UPDATE transfer_listings
           SET status = 'cancelled'
           WHERE seller_club_id = $1 AND status = 'active'`,
          [club.id],
        );
      } catch (_) {}
    }

    try {
      await client.query(
        `UPDATE forum_posts SET username = $2, user_id = NULL WHERE user_id = $1`,
        [userId, anonUser],
      );
    } catch (_) {}

    try {
      await client.query(
        `UPDATE messages SET text = '[mesaj silindi]' WHERE from_user_id = $1`,
        [userId],
      );
      await client.query(
        `UPDATE messages SET text = '[mesaj silindi]' WHERE to_user_id = $1`,
        [userId],
      );
    } catch (_) {}

    try {
      await client.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
    } catch (_) {}

    try {
      await client.query(
        `UPDATE national_teams
         SET manager_user_id = NULL, manager_club_id = NULL, updated_at = NOW()
         WHERE manager_user_id = $1`,
        [userId],
      );
    } catch (_) {}
    try {
      await client.query(
        `UPDATE national_manager_applications
         SET status = 'withdrawn', decided_at = NOW()
         WHERE user_id = $1 AND status = 'pending'`,
        [userId],
      );
    } catch (_) {}

    try {
      await client.query(
        `UPDATE friendly_fixtures SET status = 'cancelled'
         WHERE proposed_by = $1 AND status IN ('pending', 'proposed', 'open')`,
        [userId],
      );
    } catch (_) {}

    try {
      await client.query(
        `UPDATE donations
         SET payer_name = NULL, note = NULL, reference_code = NULL
         WHERE user_id = $1`,
        [userId],
      );
    } catch (_) {}

    try {
      await client.query(
        `UPDATE anti_cheat_log
         SET details = COALESCE(details, '{}'::jsonb) - 'ip' - 'userAgent' - 'email'
         WHERE user_id = $1`,
        [userId],
      );
    } catch (_) {}

    try {
      await client.query(
        `INSERT INTO account_deletion_log
           (user_id, anonymized_username, club_ids, requested_by, reason)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, anonUser, clubIds, requestedBy, reason],
      );
    } catch (_) {}

    // Transaction dışında socket kes (bağlantı tutma)
    setImmediate(() => {
      try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          global.__emDisconnectUserSockets(userId, "ACCOUNT_DELETED");
        }
      } catch (_) {}
    });
    return { userId, username: anonUser, clubIds };
  });
}

function createAuthRouter() {
  const router = express.Router();

  // POST /api/auth/register
  router.post("/register", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "register", 5, 900000)) return;
      const username = String((req.body && req.body.username) || "")
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, 32);
      const password = String((req.body && req.body.password) || "");
      const emailRaw = (req.body && req.body.email) || null;
      const email = emailRaw ? String(emailRaw).trim().slice(0, 255) : null;
      const teamNameRaw = (req.body && req.body.teamName) || null;
      const teamName = teamNameRaw
        ? String(teamNameRaw)
            .replace(/[<>]/g, "")
            .trim()
            .slice(0, 48) || null
        : null;
      const country =
        String((req.body && req.body.country) || "Türkiye")
          .replace(/[<>]/g, "")
          .trim() || "Türkiye";
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

      const ageAccepted =
        req.body &&
        (req.body.ageAccepted === true ||
          req.body.ageAccepted === "true" ||
          req.body.ageAccepted === 1 ||
          req.body.ageAccepted === "1");
      const legalAccepted =
        req.body &&
        (req.body.legalAccepted === true ||
          req.body.legalAccepted === "true" ||
          req.body.legalAccepted === 1 ||
          req.body.legalAccepted === "1");
      // İstemci checkbox göndermese bile production'da sıkı tutmak opsiyonel değil:
      // ageAccepted zorunlu (KVKK çocuk maddesi ile uyum)
      if (!ageAccepted) {
        return res.status(400).json({
          error:
            "Kayıt için 16+ yaş / yasal temsilci onayını kabul etmelisiniz",
          code: "AGE_REQUIRED",
        });
      }
      if (!legalAccepted) {
        return res.status(400).json({
          error: "Gizlilik ve kullanım koşullarını kabul etmelisiniz",
          code: "LEGAL_REQUIRED",
        });
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

      const mailer = require("../mailer");
      let verifyToken = null;
      let verifyExpires = null;
      if (email) {
        verifyToken = mailer.makeVerifyToken();
        verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }

      const { rows: userRows } = await db.query(
        `INSERT INTO users (
           username, password_hash, email, security_question, security_answer_hash,
           email_verify_token, email_verify_expires, email_verified_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         RETURNING id, username, email, created_at, email_verified_at`,
        [
          username,
          passwordHash,
          email,
          securityQuestion,
          answerHash,
          verifyToken,
          verifyExpires,
        ],
      );
      const user = userRows[0];

      if (email && verifyToken) {
        try {
          await mailer.sendEmailVerification(email, verifyToken);
        } catch (eMail) {
          console.warn("[auth/register] verify mail", eMail.message || eMail);
        }
      }

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
        user: {
          ...userPublic(user),
          emailVerified: false,
        },
        club: clubPublic(club),
        emailVerificationPending: !!email,
      });
    } catch (e) {
      console.error("[auth/register]", e);
      // GÜVENLİK: eşzamanlı kayıt yarışında (bkz. migration 029) DB artık
      // case-insensitive UNIQUE index ile ikinci INSERT'i reddediyor —
      // bunu generic 500 yerine kullanıcıya anlamlı 409 olarak döndür.
      if (e && e.code === "23505") {
        return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
      }
      res.status(500).json({ error: "Kayıt başarısız" });
    }
  });

  // POST /api/auth/login
  router.post("/login", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "login", 12, 900000)) return;
      const username = String((req.body && req.body.username) || "").trim();
      const password = String((req.body && req.body.password) || "");
      const clientIp = clientKey(req);
      if (!username || !password) {
        return res.status(400).json({ error: "Kullanıcı adı ve şifre gerekli" });
      }
      // Önceki başarısız denemelere göre kademeli gecikme (yanıt öncesi)
      await sleep(progressiveIpDelayMs(clientIp));

      const { rows } = await db.query(
        `SELECT id, username, email, password_hash, is_banned, banned_until, ban_reason,
                deleted_at, email_verified_at, last_login_at,
                COALESCE(failed_login_count, 0) AS failed_login_count,
                locked_until,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      if (!user) {
        recordIpLoginFail(clientIp);
        return res.status(401).json({ error: "Kullanıcı adı veya şifre hatalı" });
      }

      if (user.deleted_at) {
        return res.status(403).json({
          error: "Bu hesap kapatılmış",
          code: "ACCOUNT_DELETED",
        });
      }

      // Hesap bazlı kilit (LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES)
      const maxFails = Math.max(
        3,
        Number(process.env.LOGIN_MAX_FAILURES || 8) || 8,
      );
      const lockMinutes = Math.max(
        1,
        Number(process.env.LOGIN_LOCK_MINUTES || 15) || 15,
      );
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const retryMs = new Date(user.locked_until).getTime() - Date.now();
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(retryMs / 1000))),
        );
        return res.status(429).json({
          error:
            "Çok fazla hatalı giriş. Hesap geçici olarak kilitlendi. Bir süre sonra tekrar dene.",
          code: "ACCOUNT_LOCKED",
          locked_until: user.locked_until,
          retryAfterMs: retryMs,
        });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        const fails = Number(user.failed_login_count || 0) + 1;
        let lockedUntil = null;
        if (fails >= maxFails) {
          lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
        }
        try {
          await db.query(
            `UPDATE users SET
               failed_login_count = $2,
               locked_until = $3
             WHERE id = $1`,
            [user.id, fails, lockedUntil],
          );
        } catch (_) {}
        recordIpLoginFail(clientIp);
        if (lockedUntil) {
          try {
            notifySecurityEvent({
              event: "ACCOUNT_LOCKED",
              message:
                "Hesap kilitlendi: " +
                user.username +
                " (" +
                lockMinutes +
                " dk)",
              username: user.username,
              userId: user.id,
              ip: clientIp,
              lockMinutes,
              failed_login_count: fails,
            });
          } catch (_) {}
          res.setHeader("Retry-After", String(lockMinutes * 60));
          return res.status(429).json({
            error:
              "Çok fazla hatalı giriş. Hesap " +
              lockMinutes +
              " dakika kilitlendi.",
            code: "ACCOUNT_LOCKED",
            locked_until: lockedUntil.toISOString(),
            retryAfterMs: lockMinutes * 60 * 1000,
          });
        }
        const remaining = Math.max(0, maxFails - fails);
        return res.status(401).json({
          error:
            "Kullanıcı adı veya şifre hatalı" +
            (remaining > 0
              ? " · Kalan deneme: " + remaining
              : ""),
          code: "BAD_CREDENTIALS",
          remainingAttempts: remaining,
          maxFailures: maxFails,
        });
      }

      // E-posta zorunlu doğrulama (EMAIL_REQUIRE_VERIFIED=1)
      const requireVerified =
        String(process.env.EMAIL_REQUIRE_VERIFIED || "") === "1" ||
        String(process.env.EMAIL_REQUIRE_VERIFIED || "").toLowerCase() ===
          "true";
      if (
        requireVerified &&
        user.email &&
        !user.email_verified_at
      ) {
        return res.status(403).json({
          error:
            "Giriş için e-posta doğrulaması gerekli. Mailindeki bağlantıyı aç veya Ayarlar'dan tekrar gönder.",
          code: "EMAIL_NOT_VERIFIED",
          email: user.email,
        });
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

      const previousLastLoginAt = user.last_login_at || null;
      clearIpLoginFails(clientIp);
      await db.query(
        `UPDATE users SET
           last_login_at = NOW(),
           failed_login_count = 0,
           locked_until = NULL
         WHERE id = $1`,
        [user.id],
      );

      const tokens = tokenPair(user, clubId);
      res.json({
        ...tokens,
        user: {
          ...userPublic(user),
          emailVerified: !!user.email_verified_at,
          lastLoginAt: new Date().toISOString(),
          previousLastLoginAt,
        },
        previousLastLoginAt,
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
        decoded = jwt.verify(refreshToken, JWT_SECRET, { algorithms: ["HS256"] });
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
        `SELECT id, username, email, is_banned, banned_until, ban_reason,
                deleted_at, email_verified_at,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      if (!user) {
        return res.status(401).json({ error: "Kullanıcı bulunamadı" });
      }
      if (user.deleted_at) {
        return res.status(401).json({
          error: "Bu hesap kapatılmış",
          code: "ACCOUNT_DELETED",
        });
      }
      {
        const requireVerified =
          String(process.env.EMAIL_REQUIRE_VERIFIED || "") === "1" ||
          String(process.env.EMAIL_REQUIRE_VERIFIED || "").toLowerCase() ===
            "true";
        if (requireVerified && user.email && !user.email_verified_at) {
          return res.status(403).json({
            error: "E-posta doğrulaması gerekli",
            code: "EMAIL_NOT_VERIFIED",
          });
        }
      }
      // Refresh token iptal kontrolü
      const tv = tokenVersionOf(user);
      if (decoded.tv == null || Number(decoded.tv) !== tv) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş, tekrar giriş yapın",
          code: "TOKEN_REVOKED",
        });
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
    const started = Date.now();
    const pad = async () => {
      // timing yakınlaştırması (kullanıcı var/yok sızıntısını azalt)
      const elapsed = Date.now() - started;
      if (elapsed < 400) {
        await new Promise((r) => setTimeout(r, 400 - elapsed));
      }
    };
    try {
      if (!authRateLimit(req, res, "reset-password", 5, 900000)) return;
      const username = String((req.body && req.body.username) || "").trim();
      const answer = String((req.body && req.body.answer) || "").trim();
      const newPassword = String((req.body && req.body.newPassword) || "");
      // GÜVENLİK: bkz. clientKey() — ham X-Forwarded-For kullanılmaz.
      const ip = req.ip || "unknown";

      if (!username || !answer || !newPassword || newPassword.length < 8) {
        await pad();
        return res.status(400).json({
          error: "username, answer ve newPassword (min 8) gerekli",
        });
      }
      if (newPassword.length > 128) {
        await pad();
        return res.status(400).json({ error: "Şifre çok uzun" });
      }

      const lock = checkResetLock(username, ip);
      if (!lock.ok) {
        await pad();
        res.setHeader(
          "Retry-After",
          String(Math.ceil((lock.retryAfterMs || 1000) / 1000)),
        );
        return res.status(429).json({
          error: "Çok fazla hatalı deneme. 15 dakika sonra tekrar deneyin.",
          code: "RESET_LOCKED",
          retryAfterMs: lock.retryAfterMs,
        });
      }

      const { rows } = await db.query(
        `SELECT id, security_answer_hash FROM users WHERE LOWER(username) = LOWER($1)`,
        [username],
      );
      const user = rows[0];
      // Kullanıcı yok / cevap yok — aynı mesaj (enumeration azalt)
      if (!user || !user.security_answer_hash) {
        recordResetFail(username, ip);
        await pad();
        return res.status(403).json({ error: "Güvenlik cevabı hatalı veya kullanıcı yok" });
      }
      const ok = await bcrypt.compare(
        answer.toLowerCase().trim(),
        user.security_answer_hash,
      );
      if (!ok) {
        recordResetFail(username, ip);
        await pad();
        return res.status(403).json({ error: "Güvenlik cevabı hatalı veya kullanıcı yok" });
      }
      const hash = await bcrypt.hash(newPassword, 10);
      await db.query(
        `UPDATE users SET
           password_hash = $1,
           failed_login_count = 0,
           locked_until = NULL
         WHERE id = $2`,
        [hash, user.id],
      );
      // Eski access/refresh tokenları düşür
      await bumpTokenVersion(user.id);
      try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          global.__emDisconnectUserSockets(user.id, "TOKEN_REVOKED");
        }
      } catch (_) {}
      clearResetFails(username, ip);
      await pad();
      res.json({ ok: true, message: "Şifre sıfırlandı. Tekrar giriş yapın." });
    } catch (e) {
      console.error("[auth/reset-password]", e);
      res.status(500).json({ error: "Sıfırlama başarısız" });
    }
  });




  // POST /api/auth/verify-email  { token }
  router.post("/verify-email", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "verify-email", 20, 900000)) return;
      const token = String((req.body && req.body.token) || "").trim();
      if (!token || token.length < 16) {
        return res.status(400).json({ error: "Geçersiz doğrulama kodu" });
      }
      const { rows } = await db.query(
        `SELECT id, email, email_verified_at, email_verify_expires, deleted_at
         FROM users WHERE email_verify_token = $1`,
        [token],
      );
      const user = rows[0];
      if (!user || user.deleted_at) {
        return res.status(400).json({ error: "Geçersiz veya kullanılmış bağlantı" });
      }
      if (user.email_verified_at) {
        return res.json({ ok: true, message: "E-posta zaten doğrulanmış" });
      }
      if (
        user.email_verify_expires &&
        new Date(user.email_verify_expires) < new Date()
      ) {
        return res.status(400).json({
          error: "Bağlantının süresi dolmuş. Ayarlardan yeni doğrulama iste.",
          code: "TOKEN_EXPIRED",
        });
      }
      await db.query(
        `UPDATE users SET
           email_verified_at = NOW(),
           email_verify_token = NULL,
           email_verify_expires = NULL
         WHERE id = $1`,
        [user.id],
      );
      res.json({ ok: true, message: "E-posta doğrulandı" });
    } catch (e) {
      console.error("[auth/verify-email]", e);
      res.status(500).json({ error: "Doğrulama başarısız" });
    }
  });


  // POST /api/auth/resend-verification-public
  // Giriş yapılamadan (EMAIL_REQUIRE_VERIFIED) doğrulama maili iste
  // Body: { username } veya { email }
  router.post("/resend-verification-public", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "resend-verification-public", 5, 900000))
        return;
      const username = String((req.body && req.body.username) || "")
        .trim()
        .slice(0, 32);
      const email = String((req.body && req.body.email) || "")
        .trim()
        .slice(0, 255);
      if (!username && !email) {
        return res.status(400).json({
          error: "Kullanıcı adı veya e-posta gerekli",
        });
      }

      let rows;
      if (username) {
        ({ rows } = await db.query(
          `SELECT id, email, email_verified_at, deleted_at
           FROM users WHERE LOWER(username) = LOWER($1)`,
          [username],
        ));
      } else {
        ({ rows } = await db.query(
          `SELECT id, email, email_verified_at, deleted_at
           FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL`,
          [email],
        ));
      }
      const user = rows[0];

      // Enumeration azalt: her durumda benzer yanıt
      const generic = {
        ok: true,
        message:
          "Eğer hesap varsa ve e-posta doğrulanmamışsa doğrulama bağlantısı gönderildi.",
      };

      if (!user || user.deleted_at) {
        return res.json(generic);
      }
      if (!user.email) {
        return res.json(generic);
      }
      if (user.email_verified_at) {
        return res.json({
          ok: true,
          message: "Bu hesap zaten doğrulanmış. Giriş yapmayı dene.",
          alreadyVerified: true,
        });
      }

      const mailer = require("../mailer");
      const verifyToken = mailer.makeVerifyToken();
      const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.query(
        `UPDATE users SET email_verify_token = $2, email_verify_expires = $3
         WHERE id = $1`,
        [user.id, verifyToken, verifyExpires],
      );
      try {
        await mailer.sendEmailVerification(user.email, verifyToken);
      } catch (eMail) {
        console.warn(
          "[auth/resend-verification-public]",
          eMail.message || eMail,
        );
      }
      res.json(generic);
    } catch (e) {
      console.error("[auth/resend-verification-public]", e);
      res.status(500).json({ error: "Gönderim başarısız" });
    }
  });

  // POST /api/auth/resend-verification
  router.post("/resend-verification", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "resend-verification", 5, 900000)) return;
      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Token gerekli" });
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const userId = decoded.sub;
      const { rows } = await db.query(
        `SELECT id, email, email_verified_at, deleted_at,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      if (!user || user.deleted_at) {
        return res.status(401).json({ error: "Oturum geçersiz" });
      }
      if (decoded.tv == null || Number(decoded.tv) !== Number(user.token_version)) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş",
          code: "TOKEN_REVOKED",
        });
      }
      if (!user.email) {
        return res.status(400).json({ error: "Hesapta e-posta yok" });
      }
      if (user.email_verified_at) {
        return res.json({ ok: true, message: "E-posta zaten doğrulanmış" });
      }
      const mailer = require("../mailer");
      const verifyToken = mailer.makeVerifyToken();
      const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await db.query(
        `UPDATE users SET email_verify_token = $2, email_verify_expires = $3
         WHERE id = $1`,
        [userId, verifyToken, verifyExpires],
      );
      const sent = await mailer.sendEmailVerification(user.email, verifyToken);
      res.json({
        ok: true,
        message: "Doğrulama bağlantısı gönderildi",
        provider: sent.provider || null,
      });
    } catch (e) {
      console.error("[auth/resend-verification]", e);
      res.status(500).json({ error: "Gönderim başarısız" });
    }
  });

  // GET /api/auth/me
  router.get("/me", async (req, res) => {
    try {
      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Token gerekli" });
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const { rows } = await db.query(
        `SELECT id, username, email, created_at, last_login_at,
                email_verified_at, deleted_at,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [decoded.sub],
      );
      const user = rows[0];
      if (!user || user.deleted_at) {
        return res.status(401).json({ error: "Oturum geçersiz" });
      }
      if (decoded.tv == null || Number(decoded.tv) !== Number(user.token_version)) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş",
          code: "TOKEN_REVOKED",
        });
      }
      res.json({
        user: {
          ...userPublic(user),
          emailVerified: !!user.email_verified_at,
          emailVerifiedAt: user.email_verified_at,
          createdAt: user.created_at,
          lastLoginAt: user.last_login_at,
        },
      });
    } catch (e) {
      console.error("[auth/me]", e);
      res.status(500).json({ error: "Profil alınamadı" });
    }
  });

  // POST /api/auth/change-password — girişliyken şifre değiştir
  // Body: { currentPassword, newPassword }
  router.post("/change-password", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "change-password", 8, 900000)) return;

      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) {
        return res.status(401).json({ error: "Token gerekli" });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const userId = decoded.sub;
      if (!userId) return res.status(401).json({ error: "Geçersiz token" });

      const currentPassword = String(
        (req.body && req.body.currentPassword) || "",
      );
      const newPassword = String((req.body && req.body.newPassword) || "");
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          error: "Mevcut ve yeni şifre gerekli",
        });
      }
      if (newPassword.length < 8) {
        return res.status(400).json({ error: "Yeni şifre en az 8 karakter olmalı" });
      }
      if (newPassword.length > 128) {
        return res.status(400).json({ error: "Şifre çok uzun" });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({
          error: "Yeni şifre eskisiyle aynı olamaz",
        });
      }

      const { rows } = await db.query(
        `SELECT id, password_hash, deleted_at,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [userId],
      );
      const user = rows[0];
      if (!user || user.deleted_at) {
        return res.status(401).json({ error: "Oturum geçersiz" });
      }
      const tv = Number(user.token_version) || 0;
      if (decoded.tv == null || Number(decoded.tv) !== tv) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş, tekrar giriş yapın",
          code: "TOKEN_REVOKED",
        });
      }

      const ok = await bcrypt.compare(currentPassword, user.password_hash);
      if (!ok) {
        return res.status(403).json({ error: "Mevcut şifre hatalı" });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await db.query(
        `UPDATE users SET
           password_hash = $1,
           failed_login_count = 0,
           locked_until = NULL
         WHERE id = $2`,
        [hash, userId],
      );
      // Tüm cihazlardaki oturumları düşür — yeni giriş gerekir
      await bumpTokenVersion(userId);
      try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          global.__emDisconnectUserSockets(userId, "TOKEN_REVOKED");
        }
      } catch (_) {}

      res.json({
        ok: true,
        message: "Şifre güncellendi. Tekrar giriş yapın.",
        requireRelogin: true,
      });
    } catch (e) {
      console.error("[auth/change-password]", e);
      res.status(500).json({ error: "Şifre değiştirilemedi" });
    }
  });

  // GET /api/auth/export-data — KVKK erişim / veri taşınabilirliği
  router.get("/export-data", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "export-data", 5, 900000)) return;

      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) {
        return res.status(401).json({ error: "Token gerekli" });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const userId = decoded.sub;
      if (!userId) return res.status(401).json({ error: "Geçersiz token" });

      const { rows: userRows } = await db.query(
        `SELECT id, username, email, created_at, last_login_at,
                deleted_at, COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [userId],
      );
      const user = userRows[0];
      if (!user || user.deleted_at) {
        return res.status(401).json({ error: "Oturum geçersiz" });
      }
      const tv = Number(user.token_version) || 0;
      if (decoded.tv == null || Number(decoded.tv) !== tv) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş, tekrar giriş yapın",
          code: "TOKEN_REVOKED",
        });
      }

      const club = await clubsRepo.getClubByUserId(userId);

      let players = [];
      if (club && club.id) {
        try {
          const { rows } = await db.query(
            `SELECT id, name, number, pos, age, goals, assists, minutes_played,
                    from_academy, from_market, created_at
             FROM players WHERE club_id = $1 ORDER BY name`,
            [club.id],
          );
          players = rows;
        } catch (_) {}
      }

      let donations = [];
      try {
        const { rows } = await db.query(
          `SELECT id, plan, amount_cents, currency, method, status,
                  created_at, reviewed_at
           FROM donations WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        );
        donations = rows;
      } catch (_) {}

      let elite = [];
      try {
        const { rows } = await db.query(
          `SELECT id, plan, amount_cents, status, created_at
           FROM elite_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [userId],
        );
        elite = rows;
      } catch (_) {}

      let achievements = [];
      try {
        const { rows } = await db.query(
          `SELECT achievement_id, unlocked_at
           FROM user_achievements WHERE user_id = $1 ORDER BY unlocked_at DESC`,
          [userId],
        );
        achievements = rows;
      } catch (_) {}

      let forumCount = 0;
      try {
        const { rows } = await db.query(
          `SELECT COUNT(*)::int AS c FROM forum_posts WHERE user_id = $1`,
          [userId],
        );
        forumCount = rows[0] ? rows[0].c : 0;
      } catch (_) {}

      const payload = {
        exportedAt: new Date().toISOString(),
        purpose: "KVKK md.11 erişim / veri taşınabilirliği",
        user: {
          id: user.id,
          username: user.username,
          email: user.email || null,
          createdAt: user.created_at,
          lastLoginAt: user.last_login_at,
          userNo: userNoFromId(user.id),
        },
        club: club
          ? {
              id: club.id,
              name: club.name,
              country: club.country,
              division: club.division,
              balance: Number(club.balance) || 0,
              createdAt: club.created_at || null,
            }
          : null,
        players,
        donations,
        elitePayments: elite,
        achievements,
        forumPostCount: forumCount,
        note:
          "Şifre ve güvenlik cevabı hash'leri güvenlik nedeniyle dışa aktarılmaz. " +
          "IP tabanlı rate-limit kayıtları process belleğindedir ve kalıcı saklanmaz.",
      };

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="elite-manager-verilerim.json"',
      );
      res.json(payload);
    } catch (e) {
      console.error("[auth/export-data]", e);
      res.status(500).json({ error: "Veri dışa aktarma başarısız" });
    }
  });

  // POST /api/auth/delete-account — kendi hesabını kapat (KVKK soft-delete)
  // Body: { password } zorunlu (self). Admin: { targetUsername?, password? }
  router.post("/delete-account", async (req, res) => {
    try {
      if (!authRateLimit(req, res, "delete-account", 5, 900000)) return;

      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) {
        return res.status(401).json({ error: "Token gerekli" });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const actorId = decoded.sub;
      if (!actorId) return res.status(401).json({ error: "Geçersiz token" });

      const { rows: actorRows } = await db.query(
        `SELECT id, username, password_hash, deleted_at,
                COALESCE(token_version, 0) AS token_version
         FROM users WHERE id = $1`,
        [actorId],
      );
      const actor = actorRows[0];
      if (!actor || actor.deleted_at) {
        return res.status(401).json({ error: "Oturum geçersiz" });
      }
      const tv = Number(actor.token_version) || 0;
      if (decoded.tv == null || Number(decoded.tv) !== tv) {
        return res.status(401).json({
          error: "Oturum iptal edilmiş, tekrar giriş yapın",
          code: "TOKEN_REVOKED",
        });
      }

      const adminUsername = process.env.ADMIN_USERNAME || "";
      const isAdminActor =
        adminUsername &&
        String(actor.username).toLowerCase() ===
          String(adminUsername).toLowerCase();

      const body = req.body || {};
      const targetUsername = body.targetUsername
        ? String(body.targetUsername).trim()
        : "";
      const password = body.password != null ? String(body.password) : "";

      let targetId = actorId;
      if (targetUsername) {
        if (!isAdminActor) {
          return res.status(403).json({
            error: "Başka hesabı silmek için admin yetkisi gerekli",
          });
        }
        const { rows: tRows } = await db.query(
          `SELECT id, username, deleted_at FROM users
           WHERE LOWER(username) = LOWER($1)`,
          [targetUsername],
        );
        if (!tRows[0]) {
          return res.status(404).json({ error: "Hedef kullanıcı bulunamadı" });
        }
        if (tRows[0].deleted_at) {
          return res.status(409).json({ error: "Hesap zaten kapatılmış" });
        }
        targetId = tRows[0].id;
      } else {
        if (!password) {
          return res.status(400).json({
            error: "Hesap kapatmak için şifrenizi girin",
            code: "PASSWORD_REQUIRED",
          });
        }
        const ok = await bcrypt.compare(password, actor.password_hash);
        if (!ok) {
          return res.status(403).json({ error: "Şifre hatalı" });
        }
      }

      const result = await softDeleteAccount(targetId, {
        requestedBy: actorId,
        reason: targetId === actorId ? "user_request" : "admin_request",
      });

      if (targetId !== actorId) {
        try {
          const { writeAdminAudit, clientIp } = require("../adminAudit");
          await writeAdminAudit({
            adminId: actorId,
            action: "account_delete",
            targetUserId: targetId,
            targetLabel: result.username,
            details: {
              anonymizedUsername: result.username,
              clubIds: result.clubIds || [],
            },
            ip: clientIp(req),
          });
        } catch (_) {}
      }

      res.json({
        ok: true,
        message:
          targetId === actorId
            ? "Hesabınız kapatıldı. Kişisel verileriniz anonimleştirildi."
            : "Hesap kapatıldı ve anonimleştirildi.",
        anonymizedUsername: result.username,
        self: targetId === actorId,
      });
    } catch (e) {
      console.error("[auth/delete-account]", e);
      const status = e.status || 500;
      res.status(status).json({
        error: e.status ? e.message : "Hesap kapatma başarısız",
      });
    }
  });

  // POST /api/auth/logout-all — mevcut token ile tüm oturumları iptal
  router.post("/logout-all", async (req, res) => {
    try {
      const hdr = req.headers.authorization || "";
      const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
      if (!token) {
        return res.status(401).json({ error: "Token gerekli" });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch (_) {
        return res.status(401).json({ error: "Geçersiz token" });
      }
      if (decoded.typ === "refresh") {
        return res.status(401).json({ error: "Access token gerekli" });
      }
      const userId = decoded.sub;
      if (!userId) return res.status(401).json({ error: "Geçersiz token" });
      await bumpTokenVersion(userId);
      try {
        if (typeof global.__emDisconnectUserSockets === "function") {
          global.__emDisconnectUserSockets(userId, "TOKEN_REVOKED");
        }
      } catch (_) {}
      res.json({ ok: true, message: "Tüm oturumlar sonlandırıldı" });
    } catch (e) {
      console.error("[auth/logout-all]", e);
      res.status(500).json({ error: "İşlem başarısız" });
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
  bumpTokenVersion,
  tokenVersionOf,
  softDeleteAccount,
};
