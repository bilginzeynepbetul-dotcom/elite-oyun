// ============================================================
// server.js — Elite Manager API + Socket.IO giriş noktası
// ------------------------------------------------------------
//   npm start   → migrate + node server.js
//   npm run dev → nodemon server.js
// ============================================================

require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const logger = require("./logger");
const errorTracker = require("./errorTracker");
const { authMiddleware, isAdmin } = require("./authMiddleware");
const {
  createAuthRouter,
  enrichClubId,
  userNoFromId,
  clubPublic,
  userPublic,
} = require("./routes/authRoutes");

const clubsRepo = require("./repos/clubsRepo");
const leagueRepo = require("./repos/leagueRepo");
const socialRepo = require("./repos/socialRepo");
const managerProfile = require("./managerProfile");

const youthSystem = require("./youthSystem");
const transferSystem = require("./transferSystem");
const stadiumSystem = require("./stadiumSystem");
const trainingSystem = require("./trainingSystem");
const staffSystem = require("./staffSystem");
const socialSystem = require("./socialSystem");

// Route factories
const { createLeagueRouter } = require("./leagueRoutes");
const { createNationalRouter } = require("./nationalRoutes");
const { createPremiumRouter } = require("./premiumRoutes");
const { createInstantMatchRouter } = require("./instantMatchRoutes");
const { createCupRouter } = require("./cupRoutes");
const { createContractRouter } = require("./contractRoutes");
const { createFriendlyRouter } = require("./friendlyRoutes");
const { createBotRouter } = require("./botRoutes");
const { createContinentalRouter } = require("./continentalRoutes");
const { createMatchArchiveRouter } = require("./matchArchiveRoutes");
const { createAchievementsRouter } = require("./achievementsRoutes");
const { createDailyChallengeRouter } = require("./dailyChallengeRoutes");
const { createAdminSeasonRouter, createPublicAnnouncementsRouter } = require("./adminSeasonRoutes");
const { createAdminCompatRouter } = require("./adminCompatRoutes");
const adminAntiCheatRouter = require("./adminAntiCheatRoutes");

const { startScheduler } = require("./matchScheduler");
const { Match } = require("./matchEngine");
const antiCheat = require("./antiCheat");

// ------------------------------------------------------------
// Env kontrol
// ------------------------------------------------------------
if (!process.env.JWT_SECRET) {
  console.error(
    "[boot] JWT_SECRET tanımlı değil. .env dosyasına ekleyin (openssl rand -hex 32).",
  );
  process.exit(1);
}
if (String(process.env.JWT_SECRET).length < 16) {
  console.error(
    "[boot] JWT_SECRET çok kısa (<16). Production için openssl rand -hex 32 kullanın.",
  );
  process.exit(1);
}
const isProd =
  String(process.env.NODE_ENV || "").toLowerCase() === "production";
if (!process.env.DATABASE_URL) {
  if (isProd) {
    console.error("[boot] Production'da DATABASE_URL zorunlu.");
    process.exit(1);
  }
  console.warn(
    "[boot] DATABASE_URL yok — DB bağlantısı başarısız olabilir.",
  );
}
if (!process.env.CORS_ORIGIN || !String(process.env.CORS_ORIGIN).trim()) {
  if (isProd) {
    console.error(
      "[boot] Production'da CORS_ORIGIN zorunlu. Domain yazın (virgülle birden fazla).",
    );
    process.exit(1);
  }
  console.warn(
    "[boot] CORS_ORIGIN boş — tüm origin'lere izin veriliyor. Production'da domain yazın.",
  );
}
if (!process.env.ADMIN_USERNAME || !String(process.env.ADMIN_USERNAME).trim()) {
  if (isProd) {
    console.error(
      "[boot] Production'da ADMIN_USERNAME zorunlu (admin kayıt kullanıcı adı).",
    );
    process.exit(1);
  }
  console.warn(
    "[boot] ADMIN_USERNAME yok — admin paneli / ban / sezon yetkisi çalışmaz.",
  );
}
if (process.env.ELITE_ALLOW_MOCK === "1") {
  if (isProd) {
    console.error(
      "[boot] Production'da ELITE_ALLOW_MOCK=1 yasak. Kapatın.",
    );
    process.exit(1);
  }
  console.warn(
    "[boot] ELITE_ALLOW_MOCK=1 — mock ödeme AÇIK. Production'da kapatın.",
  );
}

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ------------------------------------------------------------
// Express + HTTP + Socket.IO
// ------------------------------------------------------------
const app = express();
// Render / Nginx arkasında gerçek client IP (rate limit + log için)
app.set("trust proxy", 1);
const server = http.createServer(app);

const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : true;

const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

/** @type {Map<string, import('./matchEngine').Match>} */
const liveMatches = new Map();

function getIo() {
  return io;
}
function getLiveMatches() {
  return liveMatches;
}

/** Kullanıcının tüm socket bağlantılarını kes (token iptali / ban) */
function disconnectUserSockets(userId, reason) {
  if (!userId || !io) return 0;
  const uid = String(userId);
  let n = 0;
  try {
    for (const [, sock] of io.of("/").sockets) {
      if (sock.user && String(sock.user.id) === uid) {
        try {
          sock.emit("session:ended", {
            code: reason || "TOKEN_REVOKED",
            message: "Oturumunuz sonlandırıldı. Tekrar giriş yapın.",
          });
        } catch (_) {}
        try {
          sock.disconnect(true);
        } catch (_) {}
        n += 1;
      }
    }
  } catch (e) {
    try {
      logger.warn("disconnectUserSockets", { err: e });
    } catch (_) {}
  }
  return n;
}
global.__emDisconnectUserSockets = disconnectUserSockets;
global.__emGetIo = getIo;


app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Temel güvenlik başlıkları (helmet bağımlılığı olmadan)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  // Hafif CSP — inline script/style mevcut UI için gerekli; object/base kısıtlı
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; " +
      "font-src 'self' data:; " +
      "connect-src 'self' ws: wss:; " +
      "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  // Production'da HTTPS zorunlu kıl (Render TLS termination yapıyor,
  // tarayıcıya bir sonraki ziyaretlerde otomatik https'e geçmesini söyler)
  if (isProd) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
  if (req.path && String(req.path).startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// Request id + yavaş/5xx log (errorTracker)
try {
  if (typeof errorTracker.requestContextMiddleware === "function") {
    app.use(errorTracker.requestContextMiddleware());
  }
} catch (_) {}

// ------------------------------------------------------------
// Bakım modu — env (zorunlu) VEYA game_settings (admin runtime)
// Env MAINTENANCE_MODE=1 → her zaman açık (API ile kapatılamaz)
// DB key: maintenance_mode=1 / maintenance_message
// ------------------------------------------------------------
const _maintCache = {
  at: 0,
  on: false,
  message: null,
  source: "none",
  ttlMs: 3000,
};

function envMaintenanceOn() {
  const v = String(process.env.MAINTENANCE_MODE || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function defaultMaintenanceMessage() {
  return (
    process.env.MAINTENANCE_MESSAGE ||
    "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene."
  );
}

async function getMaintenanceState() {
  if (envMaintenanceOn()) {
    return {
      on: true,
      message: defaultMaintenanceMessage(),
      source: "env",
    };
  }
  const now = Date.now();
  if (now - _maintCache.at < _maintCache.ttlMs) {
    return {
      on: _maintCache.on,
      message: _maintCache.message || defaultMaintenanceMessage(),
      source: _maintCache.source,
    };
  }
  try {
    const seasonConfig = require("./seasonConfig");
    const raw = await seasonConfig.getSetting("maintenance_mode", "0");
    const msg = await seasonConfig.getSetting("maintenance_message", null);
    const on =
      String(raw || "0") === "1" ||
      String(raw || "").toLowerCase() === "true";
    _maintCache.at = now;
    _maintCache.on = on;
    _maintCache.message = msg || defaultMaintenanceMessage();
    _maintCache.source = "db";
    return {
      on,
      message: _maintCache.message,
      source: "db",
    };
  } catch (e) {
    _maintCache.at = now;
    _maintCache.on = false;
    _maintCache.source = "error";
    return { on: false, message: defaultMaintenanceMessage(), source: "error" };
  }
}

/** Sync uyumluluk — cache'e bakar; yoksa env */
function isMaintenanceMode() {
  if (envMaintenanceOn()) return true;
  return !!_maintCache.on;
}

function maintenanceMessage() {
  if (_maintCache.message) return _maintCache.message;
  return defaultMaintenanceMessage();
}

function invalidateMaintenanceCache() {
  _maintCache.at = 0;
}

// Export for admin routes
global.__emGetMaintenanceState = getMaintenanceState;
global.__emInvalidateMaintenanceCache = invalidateMaintenanceCache;

async function isAdminBearer(req) {
  try {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
    if (!token) return false;
    const jwt = require("jsonwebtoken");
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (decoded.typ === "refresh") return false;
    const adminUsername = process.env.ADMIN_USERNAME;
    if (!adminUsername) return false;
    const uname = String(decoded.username || "").toLowerCase();
    return uname === String(adminUsername).toLowerCase();
  } catch (_) {
    return false;
  }
}

// Bakım modu — API kapalı; health + statik + verify + admin serbest
app.use(async (req, res, next) => {
  let st;
  try {
    st = await getMaintenanceState();
  } catch (_) {
    return next();
  }
  if (!st || !st.on) return next();
  const p = String(req.path || "");
  if (
    !p.startsWith("/api") ||
    p === "/api/health" ||
    p === "/api/healthz" ||
    p === "/api/status" ||
    p === "/health" ||
    p === "/readyz" ||
    p === "/api/readyz" ||
    p === "/api/version" ||
    p === "/version" ||
    p === "/api/auth/verify-email" ||
    p === "/api/auth/resend-verification-public"
  ) {
    return next();
  }
  const bypass = process.env.MAINTENANCE_BYPASS_TOKEN;
  if (
    bypass &&
    (req.headers["x-maintenance-bypass"] === bypass ||
      req.query.bypass === bypass)
  ) {
    return next();
  }
  // Admin JWT ile tüm /api/admin/* (bakım aç/kapa dahil)
  if (p.startsWith("/api/admin") && (await isAdminBearer(req))) {
    return next();
  }
  res.setHeader("Retry-After", "120");
  res.status(503).json({
    error: st.message || defaultMaintenanceMessage(),
    code: "MAINTENANCE",
    maintenance: true,
    source: st.source,
  });
});

// Statik frontend — HTML/JS önbelleğe alınmasın (deploy sonrası eski UI kalmasın)
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders(res, filePath) {
      if (/\.(html?|js|css)$/i.test(filePath)) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }),
);

// Health check (Render / uptime monitörleri / Docker healthcheck için)
app.get(["/healthz", "/api/healthz"], async (req, res) => {
  let st = { on: false, message: null, source: "none" };
  try {
    st = await getMaintenanceState();
  } catch (_) {}
  try {
    await require("./db").query("SELECT 1");
    res.status(200).json({
      ok: true,
      db: "up",
      ts: Date.now(),
      maintenance: !!st.on,
      message: st.on ? st.message : undefined,
      maintenanceSource: st.source,
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      db: "down",
      error: e.message,
      maintenance: !!st.on,
    });
  }
});

// Readiness — bakım veya DB down iken 503 (yük dengeleyici trafiği keser)
// Liveness için /healthz kullanın (process ayakta mı)
app.get(["/readyz", "/api/readyz"], async (req, res) => {
  let st = { on: false, message: null, source: "none" };
  try {
    st = await getMaintenanceState();
  } catch (_) {}
  if (st.on) {
    res.setHeader("Retry-After", "120");
    return res.status(503).json({
      ok: false,
      ready: false,
      reason: "maintenance",
      maintenance: true,
      message: st.message,
      maintenanceSource: st.source,
      ts: Date.now(),
    });
  }
  try {
    await require("./db").query("SELECT 1");
    res.status(200).json({
      ok: true,
      ready: true,
      db: "up",
      maintenance: false,
      ts: Date.now(),
    });
  } catch (e) {
    res.status(503).json({
      ok: false,
      ready: false,
      reason: "db_down",
      db: "down",
      error: e.message,
      ts: Date.now(),
    });
  }
});

// Sürüm / build bilgisi (monitoring, destek)
app.get(["/api/version", "/version"], (_req, res) => {
  let pkgVersion = "0.0.0";
  try {
    pkgVersion = require("./package.json").version || pkgVersion;
  } catch (_) {}
  res.json({
    ok: true,
    name: "elite-manager",
    version: pkgVersion,
    node: process.version,
    env: process.env.NODE_ENV || "development",
    build: process.env.BUILD_SHA || process.env.RENDER_GIT_COMMIT || null,
    startedAt: global.__emStartedAt || null,
    ts: new Date().toISOString(),
  });
});

// Health (errorTracker stats dahil) + bakım durumu
app.get(["/api/health", "/api/status", "/health"], async (_req, res) => {
  let errors = null;
  try {
    errors = errorTracker.getStats && errorTracker.getStats();
  } catch (_) {}
  let st = { on: false, message: null, source: "none" };
  try {
    st = await getMaintenanceState();
  } catch (_) {}
  res.json({
    ok: true,
    name: "elite-manager",
    ts: new Date().toISOString(),
    liveMatches: liveMatches.size,
    maintenance: !!st.on,
    message: st.on ? st.message : undefined,
    maintenanceSource: st.source,
    errors,
  });
});

// ------------------------------------------------------------
// Auth (public)
// ------------------------------------------------------------

// Yasal sayfalar (kısa URL)
app.get(["/gizlilik", "/privacy", "/kvkk"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});
app.get(["/kullanim-kosullari", "/terms"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});
app.get(["/cerezler", "/cookies"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cookies.html"));
});

app.use("/api/auth", createAuthRouter());

// ------------------------------------------------------------
// Auth required API
// ------------------------------------------------------------
const api = express.Router();
api.use(authMiddleware);


/** Kulüp/kullanıcı bazlı sıkı rate limit — pahalı yazma uçları
 * GÜVENLİK: IP kısmı için ham X-Forwarded-For header'ı ASLA elle
 * parse edilmez — client bu header'ı serbestçe set edebildiğinden
 * (örn. her istekte rastgele bir değer göndererek) limiti tamamen
 * atlatabilir. `app.set("trust proxy", 1)` zaten yapılandırıldığı
 * için Express'in kendi hesapladığı req.ip güvenilir kaynaktır. */
function strictLimit(req, res, action, max, windowMs) {
  const id =
    (req.user && (req.user.id || req.user.userId)) || req.ip || "anon";
  const r = antiCheat.rateLimit("strict:" + action + ":" + id, max, windowMs);
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

// Global API rate limit (kullanıcı veya IP başına)
// GÜVENLİK: X-Forwarded-For elle parse edilmiyor (bkz. strictLimit yorumu) —
// req.ip, trust proxy ayarıyla zaten doğru client IP'sini verir.
api.use((req, res, next) => {
  const uid = (req.user && (req.user.id || req.user.userId)) || req.ip || "anon";
  const max = parseInt(process.env.API_RATE_LIMIT_MAX || "120", 10) || 120;
  const windowMs =
    parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || "60000", 10) || 60_000;
  const r = antiCheat.rateLimit("api:global:" + uid, max, windowMs);
  if (!r.ok) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil((r.retryAfterMs || 1000) / 1000)),
    );
    return res.status(429).json(r);
  }
  next();
});

// --- /api/me ---
api.get("/me", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    const club = clubId ? await clubsRepo.getClub(clubId) : null;
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email || null,
        userNo: userNoFromId(req.user.id),
      },
      club: clubPublic(club),
    });
  } catch (e) {
    logger.error("GET /me", { err: e });
    res.status(500).json({ error: "Profil alınamadı" });
  }
});

// --- /api/team ---
api.get("/team", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
    const team = await clubsRepo.getTeam(clubId);
    const club = await clubsRepo.getClub(clubId);
    if (!team) return res.status(404).json({ error: "Kadro yok" });
    const payload = {
      name: team.name,
      formation:
        team.currentFormation ||
        team.formation ||
        (club && club.formation) ||
        "4-4-2",
      currentFormation:
        team.currentFormation ||
        team.formation ||
        (club && club.formation) ||
        "4-4-2",
      gameStyle: team.gameStyle || (club && club.game_style) || "dengeli",
      passStyle: team.passStyle || (club && club.pass_style) || "kısa",
      attackDir: team.attackDir || (club && club.attack_dir) || "orta",
      players: team.players || [],
      bench: team.bench || [],
      customTactics: team.customTactics || {},
      advancedTactics: team.advancedTactics || {},
      teamBehavior: team.teamBehavior || null,
    };
    // İstemci t.team bekliyor; düz alanlar da geriye uyumluluk için
    res.json({
      club: clubPublic(club),
      team: payload,
      ...payload,
    });
  } catch (e) {
    logger.error("GET /team", { err: e });
    res.status(500).json({ error: "Kadro alınamadı" });
  }
});

api.post("/team", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const rl = antiCheat.rateLimit("team-save:" + clubId, 20, 60_000);
    if (!rl.ok) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil((rl.retryAfterMs || 1000) / 1000)),
      );
      return res.status(429).json(rl);
    }
    const body = req.body || {};
    // İstemci { team: {...} } gönderir
    const teamData = body.team || body;
    const existingTeam = await clubsRepo.getTeam(clubId);
    const sanitized = antiCheat.sanitizeTeamPayload(teamData, existingTeam);
    if (!sanitized.ok) {
      return res
        .status(400)
        .json({ error: sanitized.error, code: sanitized.code });
    }
    if (sanitized.flags && sanitized.flags.length) {
      antiCheat
        .logSuspicious(req.user && req.user.id, clubId, "team_save_flag", {
          flags: sanitized.flags,
        })
        .catch(() => {});
    }
    await clubsRepo.saveTeam(clubId, sanitized.team);
    const team = await clubsRepo.getTeam(clubId);
    res.json({ ok: true, team });
  } catch (e) {
    logger.error("POST /team", { err: e });
    res.status(500).json({ error: "Kadro kaydedilemedi" });
  }
});

// --- /api/economy ---
api.get("/economy", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const eco = await clubsRepo.getEconomy(clubId);
    if (!eco) return res.status(404).json({ error: "Kulüp yok" });
    res.json(eco);
  } catch (e) {
    logger.error("GET /economy", { err: e });
    res.status(500).json({ error: "Ekonomi alınamadı" });
  }
});

// --- /api/fixtures ---
api.get("/fixtures", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    const club = clubId ? await clubsRepo.getClub(clubId) : null;
    const country = req.query.country || (club && club.country) || "Türkiye";
    const division = parseInt(req.query.division, 10) || (club && club.division) || 1;
    const season = await leagueRepo.getCurrentSeason(country, division);
    if (!season) return res.json({ season: null, fixtures: [] });
    // Varsayılan: ligin tüm fikstürü; ?mine=1 ile sadece kendi maçları
    const fixtures = await leagueRepo.listFixtures(season.id, {
      clubId: req.query.mine === "1" ? clubId : null,
      status: req.query.status || null,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 80,
    });
    res.json({ season, fixtures });
  } catch (e) {
    logger.error("GET /fixtures", { err: e });
    res.status(500).json({ error: "Fikstür alınamadı" });
  }
});


api.get("/fixtures/next", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.json({ fixture: null, club: null });
    const club = await clubsRepo.getClub(clubId);
    const fixture = await leagueRepo.getNextFixtureForClub(clubId);
    res.json({
      fixture: fixture || null,
      club: club ? { id: club.id, name: club.name } : null,
    });
  } catch (e) {
    logger.error("GET /fixtures/next", { err: e });
    res.status(500).json({ error: "Sıradaki maç alınamadı" });
  }
});

// --- /api/transfer/* ---
api.get("/transfer/market", async (req, res) => {
  try {
    const listings = await transferSystem.listMarket();
    res.json({ listings: listings || [] });
  } catch (e) {
    logger.error("GET /transfer/market", { err: e });
    res.status(500).json({ error: "Piyasa alınamadı" });
  }
});

api.post("/transfer/list", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "transfer-list", 10, 60000)) return;
    const body = req.body || {};
    const r = await transferSystem.listPlayer(
      clubId,
      body.playerId || (body.player && body.player.id),
      body.minPrice || body.auctionStart,
      body.hours || 24,
    );
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    logger.error("POST /transfer/list", { err: e });
    res.status(500).json({ error: "İlan oluşturulamadı" });
  }
});

api.post("/transfer/bid", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const rl = antiCheat.rateLimit("transfer-bid:" + clubId, 30, 60_000);
    if (!rl.ok) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil((rl.retryAfterMs || 1000) / 1000)),
      );
      return res.status(429).json(rl);
    }
    const { listingId, amount } = req.body || {};
    if (!listingId || amount == null) {
      return res.status(400).json({ error: "listingId ve amount gerekli" });
    }
    const r = await transferSystem.placeBid(clubId, listingId, amount);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    logger.error("POST /transfer/bid", { err: e });
    res.status(500).json({ error: "Teklif verilemedi" });
  }
});

api.post("/transfer/cancel", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const { listingId } = req.body || {};
    if (!listingId) return res.status(400).json({ error: "listingId gerekli" });
    const r = await transferSystem.cancelListing(clubId, listingId);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    logger.error("POST /transfer/cancel", { err: e });
    res.status(500).json({ error: "İptal edilemedi" });
  }
});

api.post("/transfer/refresh", async (_req, res) => {
  try {
    const listings = await transferSystem.listMarket();
    res.json({ listings: listings || [] });
  } catch (e) {
    res.status(500).json({ error: "Yenilenemedi" });
  }
});

// --- /api/youth ---
api.get("/youth", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const state = await youthSystem.getState(clubId);
    res.json(state);
  } catch (e) {
    logger.error("GET /youth", { err: e });
    res.status(500).json({ error: "Altyapı alınamadı" });
  }
});

api.post("/youth/draw", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "youth-draw", 5, 60000)) return;
    const preferredSkill =
      (req.body && (req.body.preferredSkill || req.body.skill)) || null;
    const country =
      (req.body && (req.body.country || req.body.sourceCountry)) || null;
    const r = await youthSystem.drawPlayer(clubId, preferredSkill, country);
    if (!r.ok) return res.status(400).json({ error: r.error, cost: r.cost });
    res.json(r);
  } catch (e) {
    logger.error("POST /youth/draw", { err: e });
    res.status(500).json({ error: "Keşif başarısız" });
  }
});

api.post("/youth/branch", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "youth-branch", 5, 60000)) return;
    const country = (req.body && req.body.country) || null;
    const r = await youthSystem.buildBranch(clubId, country);
    if (!r.ok) return res.status(400).json({ error: r.error, cost: r.cost });
    res.json(r);
  } catch (e) {
    logger.error("POST /youth/branch", { err: e });
    res.status(500).json({ error: "Şube inşa edilemedi" });
  }
});

api.post("/youth/upgrade", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "youth-upgrade", 10, 60000)) return;
    const kind =
      (req.body && (req.body.kind || req.body.type || req.body.target)) ||
      "scout";
    const r = await youthSystem.upgrade(clubId, kind);
    if (!r.ok) return res.status(400).json({ error: r.error, cost: r.cost });
    res.json(r);
  } catch (e) {
    logger.error("POST /youth/upgrade", { err: e });
    res.status(500).json({ error: "Yükseltme başarısız" });
  }
});

// --- /api/training ---
api.get("/training", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const state = await trainingSystem.getState(clubId);
    res.json({ state });
  } catch (e) {
    res.status(500).json({ error: "Antrenman durumu alınamadı" });
  }
});

api.post("/training/squad", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "train-squad", 6, 60000)) return;
    const focus = req.body && (req.body.skill || req.body.focus);
    const r = await trainingSystem.trainSquad(clubId, focus);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Antrenman yapılamadı" });
  }
});

api.post("/training/player", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "train-player", 12, 60000)) return;
    const playerId = req.body && (req.body.playerId || req.body.id);
    const skill = req.body && req.body.skill;
    const r = await trainingSystem.trainPlayer(clubId, playerId, skill);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Antrenman yapılamadı" });
  }
});

api.post("/training/coach", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const skill = req.body && req.body.skill;
    const level = req.body && req.body.level;
    const r = await staffSystem.hireCoach(clubId, skill, level);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Antrenör alınamadı" });
  }
});

api.post("/training/coach/remove", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const skill = req.body && req.body.skill;
    const r = await staffSystem.removeCoach(clubId, skill);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Antrenör çıkarılamadı" });
  }
});

// --- /api/stadium ---
api.get("/stadium", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const state = await stadiumSystem.getState(clubId);
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: "Stadyum alınamadı" });
  }
});

api.post("/stadium/upgrade", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "stadium-up", 6, 60000)) return;
    const r = await stadiumSystem.upgradeSeats(clubId);
    if (!r.ok) return res.status(400).json({ error: r.error, cost: r.cost });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Yükseltme başarısız" });
  }
});

api.post("/stadium/ticket", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    if (!strictLimit(req, res, "stadium-ticket", 10, 60_000)) return;
    const price = Number((req.body && req.body.price) || 12);
    const r = await stadiumSystem.setTicketPrice(clubId, price);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Bilet fiyatı güncellenemedi" });
  }
});

api.post("/stadium/rename", async (req, res) => {
  try {
    const clubId = await enrichClubId(req);
    if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
    const name = String((req.body && req.body.name) || "").trim().slice(0, 64);
    const r = await stadiumSystem.rename(clubId, name);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "İsim değiştirilemedi" });
  }
});

// --- Social: forum / messages / notifications ---
api.get("/forum", async (req, res) => {
  try {
    const posts = await socialRepo.listForum(50);
    res.json({ posts: posts || [] });
  } catch (e) {
    res.status(500).json({ error: "Forum alınamadı" });
  }
});

api.post("/forum", async (req, res) => {
  try {
    if (!strictLimit(req, res, "forum-post", 8, 60_000)) return;
    const text = String((req.body && req.body.text) || "")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 200);
    if (!text) return res.status(400).json({ error: "text gerekli" });
    const post = await socialSystem.addForumPost(
      req.user.id,
      req.user.username,
      text,
    );
    res.json({ ok: true, post });
  } catch (e) {
    res.status(500).json({ error: "Gönderilemedi" });
  }
});

api.delete("/forum/:id", async (req, res) => {
  try {
    const r = await socialSystem.deleteForumPost(req.params.id, req.user.id);
    if (r && r.ok === false) {
      return res.status(403).json({ error: r.error || "Silinemedi" });
    }
    res.json({ ok: true, ...(r || {}) });
  } catch (e) {
    res.status(500).json({ error: "Silinemedi" });
  }
});

api.get("/messages", async (req, res) => {
  try {
    const messages = await socialRepo.listMessages(req.user.id);
    res.json({ messages: messages || [] });
  } catch (e) {
    res.status(500).json({ error: "Mesajlar alınamadı" });
  }
});

api.post("/messages", async (req, res) => {
  try {
    if (!strictLimit(req, res, "msg-send", 20, 60_000)) return;
    const toUsername = String((req.body && req.body.to) || "").trim();
    const text = String((req.body && req.body.text) || "")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 1000);
    if (!toUsername || !text) {
      return res.status(400).json({ error: "to ve text gerekli" });
    }
    const { rows } = await require("./db").query(
      `SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)`,
      [toUsername],
    );
    if (!rows[0]) return res.status(404).json({ error: "Alıcı bulunamadı" });
    const msg = await socialRepo.sendMessage(
      req.user.id,
      req.user.username,
      rows[0].id,
      rows[0].username,
      text,
    );
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ error: "Mesaj gönderilemedi" });
  }
});

api.post("/messages/read", async (req, res) => {
  try {
    const result = await socialRepo.markMessagesRead(req.user.id);
    res.json({ ok: true, updated: (result && result.updated) || 0 });
  } catch (e) {
    console.error("[messages/read]", e);
    res.status(500).json({ error: "Okundu işaretlenemedi" });
  }
});

api.get("/notifications", async (req, res) => {
  try {
    const items = await socialRepo.listNotifications(req.user.id);
    const unread = await socialRepo.unreadCount(req.user.id);
    res.json({ notifications: items || [], unread: unread || 0 });
  } catch (e) {
    res.status(500).json({ error: "Bildirimler alınamadı" });
  }
});

api.post("/notifications/read", async (req, res) => {
  try {
    await socialRepo.markNotificationsRead(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Okundu işaretlenemedi" });
  }
});

// --- Manager profile ---
api.get("/manager/:username", async (req, res) => {
  try {
    const profile = await managerProfile.getByUsername(req.params.username);
    if (!profile) return res.status(404).json({ error: "Bulunamadı" });
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: "Profil alınamadı" });
  }
});

// Feature routers
api.use(createLeagueRouter());
api.use("/national", createNationalRouter({
  getClubId: (req) => req.user && req.user.clubId,
  getUserId: (req) => req.user && req.user.id,
  getUsername: (req) => req.user && req.user.username,
}));
api.use("/premium", createPremiumRouter());
// Route path'leri zaten /instant/* — ek prefix YOK
api.use(createInstantMatchRouter({ getIo, getLiveMatches }));
api.use(createCupRouter());
api.use(
  "/contracts",
  createContractRouter({
    getClubId: (req) => req.user && req.user.clubId,
  }),
);
api.use(createFriendlyRouter());
api.use(createBotRouter());
api.use(createContinentalRouter());
api.use(createMatchArchiveRouter());
api.use("/achievements", createAchievementsRouter());
api.use("/challenges", createDailyChallengeRouter());

// Duyurular — herkes okur (admin korumasının dışında)
api.use(createPublicAnnouncementsRouter());

// Admin
api.use("/admin", isAdmin, createAdminSeasonRouter());
api.use("/admin", isAdmin, createAdminCompatRouter());
api.use("/admin/anti-cheat", isAdmin, adminAntiCheatRouter);

// Hata listesi — admin kullanıcı VEYA X-Error-Token (ERROR_ADMIN_TOKEN)
api.get("/admin/errors", (req, res, next) => {
  const viaToken =
    errorTracker.checkAdminToken && errorTracker.checkAdminToken(req);
  if (viaToken) return next();
  return isAdmin(req, res, next);
}, (req, res) => {
  try {
    const limit = Math.min(
      100,
      parseInt(req.query.limit || "30", 10) || 30,
    );
    res.json({
      ok: true,
      stats: errorTracker.getStats ? errorTracker.getStats() : null,
      errors: (errorTracker.getRecent || errorTracker.getRecentErrors)
        ? (errorTracker.getRecent || errorTracker.getRecentErrors)(limit)
        : [],
    });
  } catch (e) {
    logger.error("GET /admin/errors", { err: e });
    res.status(500).json({ error: "Hata listesi alınamadı" });
  }
});

app.use("/api", api);

// SPA fallback
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
    return next();
  }
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) next();
  });
});

// Global error handler (errorId + requestId client'a döner)
// errorTracker.expressErrorHandler bir factory — çağrılınca 4-arg middleware döner
app.use(
  (typeof errorTracker.expressErrorHandler === "function"
    ? errorTracker.expressErrorHandler()
    : null) ||
    ((err, _req, res, _next) => {
      logger.error("unhandled", { err });
      try {
        errorTracker.captureException && errorTracker.captureException(err);
      } catch (_) {}
      res.status(500).json({ error: "Sunucu hatası" });
    }),
);

// ------------------------------------------------------------
// Socket.IO — JWT auth + maç izleme
// ------------------------------------------------------------
io.use(async (socket, next) => {
  try {
    // IP başına bağlantı denemesi limiti (handshake flood)
    try {
      const ip =
        (socket.handshake && socket.handshake.address) ||
        (socket.request && socket.request.ip) ||
        "unknown";
      const maxConn = Math.max(
        20,
        Number(process.env.SOCKET_IP_CONNECT_MAX || 60) || 60,
      );
      const winMs = Math.max(
        10_000,
        Number(process.env.SOCKET_IP_CONNECT_WINDOW_MS || 60_000) || 60_000,
      );
      const rl = antiCheat.rateLimit(
        "sock:connect:" + ip,
        maxConn,
        winMs,
      );
      if (!rl.ok) {
        return next(new Error("Çok fazla bağlantı denemesi. Biraz bekleyin."));
      }
    } catch (_) {}

    const token =
      (socket.handshake.auth && socket.handshake.auth.token) ||
      (socket.handshake.query && socket.handshake.query.token) ||
      null;
    if (!token) {
      // Misafir izleme serbest (sadece public events)
      socket.user = null;
      return next();
    }
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (decoded.typ === "refresh") {
      return next(new Error("Access token gerekli"));
    }
    if (!decoded.sub) {
      return next(new Error("Geçersiz token"));
    }
    // token_version + ban kontrolü
    try {
      const { rows } = await require("./db").query(
        `SELECT COALESCE(token_version, 0) AS token_version, is_banned, banned_until,
                deleted_at
         FROM users WHERE id = $1`,
        [decoded.sub],
      );
      const u = rows[0];
      if (!u) return next(new Error("Geçersiz token"));
      if (u.deleted_at) {
        return next(new Error("Hesap kapatılmış"));
      }
      const tv = Number(u.token_version) || 0;
      if (decoded.tv == null || Number(decoded.tv) !== tv) {
        return next(new Error("Oturum iptal edilmiş"));
      }
      if (u.is_banned) {
        const until = u.banned_until ? new Date(u.banned_until) : null;
        if (!until || until > new Date()) {
          return next(new Error("Hesap engellenmiş"));
        }
      }
    } catch (_) {
      return next(new Error("Auth kontrolü başarısız"));
    }
    let clubId = decoded.clubId || null;
    if (!clubId && decoded.sub) {
      try {
        const c = await clubsRepo.getClubByUserId(decoded.sub);
        if (c) clubId = c.id;
      } catch (_) {}
    }
    socket.user = {
      id: decoded.sub,
      username: decoded.username,
      clubId: clubId || null,
      tv: decoded.tv != null ? Number(decoded.tv) : null,
    };
    next();
  } catch (e) {
    next(new Error("Geçersiz token"));
  }
});

io.on("connection", (socket) => {
  logger.info("socket connect", {
    id: socket.id,
    user: socket.user && socket.user.username,
  });

  // Socket event flood koruması
  function sockLimit(action, max, windowMs) {
    const id =
      (socket.user && socket.user.id) || socket.id || "anon";
    const r = antiCheat.rateLimit(
      "sock:" + action + ":" + id,
      max,
      windowMs,
    );
    if (!r.ok) {
      socket.emit("error:rate", {
        action,
        error: r.error,
        code: r.code,
        retryAfterMs: r.retryAfterMs,
      });
      return false;
    }
    return true;
  }

  if (socket.user && socket.user.id) {
    socket.join("user:" + socket.user.id);
    // Anlık maç presence (challenge / queue için socketId)
    try {
      const instant = require("./instantMatchSystem");
      instant.setOnline(socket.user.id, {
        username: socket.user.username,
        clubId: socket.user.clubId || null,
        socketId: socket.id,
      });
    } catch (_) {}

    // Periyodik oturum doğrulama — iptal/ban/silme sonrası uzun yaşayan socket'leri kes
    const revalidateMs = Math.max(
      60_000,
      Number(process.env.SOCKET_REVALIDATE_MS || 300000) || 300000,
    );
    const revalidateTimer = setInterval(async () => {
      if (!socket.user || !socket.user.id) return;
      try {
        const { rows } = await require("./db").query(
          `SELECT COALESCE(token_version, 0) AS token_version,
                  is_banned, banned_until, deleted_at
           FROM users WHERE id = $1`,
          [socket.user.id],
        );
        const u = rows[0];
        let kill = null;
        if (!u || u.deleted_at) kill = "ACCOUNT_DELETED";
        else if (u.is_banned) {
          const until = u.banned_until ? new Date(u.banned_until) : null;
          if (!until || until > new Date()) kill = "BANNED";
        } else if (
          socket.user.tv != null &&
          Number(socket.user.tv) !== Number(u.token_version)
        ) {
          kill = "TOKEN_REVOKED";
        }
        // tv yoksa handshake'te zaten kontrol edildi; tv'yi sakla
        if (u && socket.user.tv == null) {
          socket.user.tv = Number(u.token_version) || 0;
        }
        if (kill) {
          try {
            socket.emit("session:ended", {
              code: kill,
              message: "Oturumunuz sonlandırıldı. Tekrar giriş yapın.",
            });
          } catch (_) {}
          try {
            socket.disconnect(true);
          } catch (_) {}
        }
      } catch (_) {
        /* DB geçici hata — bir sonraki tur */
      }
    }, revalidateMs);
    if (typeof revalidateTimer.unref === "function") revalidateTimer.unref();
    socket.on("disconnect", () => {
      try {
        clearInterval(revalidateTimer);
      } catch (_) {}
    });
  }

  socket.on("fixture:watch", async (payload) => {
    try {
      if (!sockLimit("fixture-watch", 30, 60000)) return;
      const fixtureId =
        (payload && (payload.fixtureId || payload.id)) || null;
      const matchId = payload && payload.matchId;
      if (!fixtureId && !matchId) return;

      if (fixtureId) socket.join("fixture:" + fixtureId);
      if (matchId) socket.join(matchId);

      // Canlı maç state'i gönder
      let match = null;
      if (fixtureId && liveMatches.has(String(fixtureId))) {
        match = liveMatches.get(String(fixtureId));
      } else if (matchId && liveMatches.has(String(matchId))) {
        match = liveMatches.get(String(matchId));
      } else {
        for (const [, m] of liveMatches) {
          if (
            (fixtureId && String(m.fixtureId) === String(fixtureId)) ||
            (matchId && String(m.id) === String(matchId))
          ) {
            match = m;
            break;
          }
        }
      }


      if (match) {
        socket.join(match.id);
        if (match.fixtureId) socket.join("fixture:" + match.fixtureId);
        const state = match.getPublicState(true);
        socket.emit("match:state", state);
        if (match.log && match.log.length) {
          const recent = match.log.slice(-15);
          for (const entry of recent) {
            socket.emit("match:log", entry);
          }
        }
        if (socket.user && socket.user.clubId) {
          let side = null;
          if (
            match.players.home.clubId &&
            String(match.players.home.clubId) === String(socket.user.clubId)
          ) {
            side = "home";
          } else if (
            match.players.away.clubId &&
            String(match.players.away.clubId) === String(socket.user.clubId)
          ) {
            side = "away";
          }
          if (side) {
            socket.emit("match:your-side", {
              side,
              fixtureId: match.fixtureId,
              matchId: match.id,
            });
          }
        }
      } else if (fixtureId && !String(fixtureId).startsWith("inst_")) {
        // Maç henüz başlamadı — takvim bilgisi gönder (kullanıcı başlatamaz)
        try {
          const fx = await leagueRepo.getFixtureById(fixtureId);
          if (fx) {
            socket.emit("fixture:status", {
              fixtureId: fx.id,
              status: fx.status,
              kickoffAt: fx.kickoffAt,
              homeName: fx.homeName,
              awayName: fx.awayName,
              homeGoals: fx.homeGoals,
              awayGoals: fx.awayGoals,
              message:
                fx.status === "scheduled"
                  ? "Maç takvime göre otomatik başlayacak"
                  : fx.status === "finished"
                    ? "Maç sona erdi"
                    : "Maç durumu: " + fx.status,
            });
            if (socket.user && socket.user.clubId) {
              let side = null;
              if (String(fx.homeClubId) === String(socket.user.clubId))
                side = "home";
              else if (String(fx.awayClubId) === String(socket.user.clubId))
                side = "away";
              if (side) {
                socket.emit("match:your-side", {
                  side,
                  fixtureId: fx.id,
                  matchId: null,
                });
              }
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      logger.warn("fixture:watch", { err: e.message });
    }
  });

  function findLiveMatch(payload) {
    const matchId = payload && (payload.matchId || payload.id);
    const fixtureId = payload && payload.fixtureId;
    if (matchId && liveMatches.has(String(matchId))) {
      return liveMatches.get(String(matchId));
    }
    if (fixtureId && liveMatches.has(String(fixtureId))) {
      return liveMatches.get(String(fixtureId));
    }
    for (const [, m] of liveMatches) {
      if (matchId && String(m.id) === String(matchId)) return m;
      if (fixtureId && String(m.fixtureId) === String(fixtureId)) return m;
    }
    return null;
  }

  socket.on("match:tactics", (payload) => {
    try {
      if (!sockLimit("match-tactics", 20, 60000)) return;
      const side = payload && payload.side;
      const tactics = payload && payload.tactics;
      if (!side) {
        socket.emit("match:tactics:result", { ok: false, error: "side gerekli" });
        return;
      }
      const match = findLiveMatch(payload);
      if (!match) {
        socket.emit("match:tactics:result", { ok: false, error: "Maç yok" });
        return;
      }
      // Yetki: sadece kendi tarafı
      if (socket.user && socket.user.clubId) {
        const mine = match.players[side];
        if (
          mine &&
          mine.clubId &&
          String(mine.clubId) !== String(socket.user.clubId)
        ) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Bu taraf sana ait değil",
          });
          return;
        }
      }
      const r =
        typeof match.applyTacticChange === "function"
          ? match.applyTacticChange(side, tactics || {})
          : { ok: false, error: "Taktik API yok" };
      socket.emit("match:tactics:result", r || { ok: true, side });
    } catch (e) {
      socket.emit("match:tactics:result", { ok: false, error: e.message });
    }
  });

  socket.on("match:sub", (payload) => {
    try {
      if (!sockLimit("match-sub", 15, 60000)) return;
      const side = payload && payload.side;
      const outIdx = payload && payload.outIdx;
      const inIdx = payload && payload.inIdx;
      if (!side || outIdx == null || inIdx == null) {
        socket.emit("match:sub:result", {
          ok: false,
          error: "side, outIdx, inIdx gerekli",
        });
        return;
      }
      const match = findLiveMatch(payload);
      if (!match) {
        socket.emit("match:sub:result", { ok: false, error: "Maç yok" });
        return;
      }
      if (socket.user && socket.user.clubId) {
        const mine = match.players[side];
        if (
          mine &&
          mine.clubId &&
          String(mine.clubId) !== String(socket.user.clubId)
        ) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Bu taraf sana ait değil",
          });
          return;
        }
      }
      const r =
        typeof match.applySubstitution === "function"
          ? match.applySubstitution(side, Number(outIdx), Number(inIdx))
          : { ok: false, error: "Değişiklik desteklenmiyor" };
      socket.emit("match:sub:result", r || { ok: true });
    } catch (e) {
      socket.emit("match:sub:result", { ok: false, error: e.message });
    }
  });

  socket.on("disconnect", (reason) => {
    logger.debug("socket disconnect", { id: socket.id, reason });
    if (socket.user && socket.user.id) {
      try {
        const instant = require("./instantMatchSystem");
        instant.setOffline(socket.user.id, socket.id);
      } catch (_) {}
    }
  });
});

// ------------------------------------------------------------
// Scheduler + boot
// ------------------------------------------------------------
startScheduler({ io, liveMatches });
try {
  transferSystem.startTransferLoop();
} catch (e) {
  console.warn("[boot] transfer loop", e.message);
}
try {
  const contractSystem = require("./contractSystem");
  if (typeof contractSystem.startPayrollTimer === "function") {
    contractSystem.startPayrollTimer();
    console.log("[boot] payroll timer started");
  }
} catch (e) {
  console.warn("[boot] payroll", e.message);
}
try {
  socialSystem.seedForumIfEmpty().catch(() => {});
  // Tüm ülkelerin 1. ligini bot + fikstür ile işlevsel tut (idempotent)
  try {
    const seasonConfig = require("./seasonConfig");
    const botClubs = require("./botClubs");
    seasonConfig
      .ensureSeasonStartsTonight()
      .then((startAt) => {
        console.log(
          "[boot] sezon başlangıcı",
          startAt && startAt.toISOString
            ? startAt.toISOString()
            : startAt,
          "(TR gecesi)",
        );
        return botClubs.bootstrapAllLeagues({
          targetSize: 8,
          divisions: [1],
          startAt: startAt,
        });
      })
      .then((r) => {
        if (r && r.leagues)
          console.log("[boot] league bootstrap", r.leagues, "ülke/lig kontrol");
        try {
          const comp = require("./competitionBootstrap");
          return comp.bootstrapAllCompetitions();
        } catch (e2) {
          console.warn("[boot] competitionBootstrap", e2.message);
        }
      })
      .catch((e) => console.warn("[boot] league/season bootstrap", e.message));
  } catch (eBoot) {
    console.warn("[boot] league bootstrap require", eBoot.message);
  }
} catch (_) {}

// Milli takım şeması (007/009/011) — Render DB shell olmadan da tamamlanır
try {
  const { ensureNationalSchema } = require("./ensureNationalSchema");
  ensureNationalSchema().catch((e) =>
    console.warn("[boot] ensureNationalSchema", e && e.message ? e.message : e),
  );
} catch (e) {
  console.warn("[boot] ensureNationalSchema load", e.message);
}

server.listen(PORT, () => {
  logger.info("Elite Manager API dinleniyor", {
    port: PORT,
    env: process.env.NODE_ENV || "development",
  });
  console.log(`[boot] http://localhost:${PORT}`);
});

// ============================================================
// Crash koruması + Graceful Shutdown
// ------------------------------------------------------------
// - uncaughtException → log + capture + temiz kapanış + exit(1)
// - unhandledRejection → log + capture (process devam)
// - SIGTERM / SIGINT  → HTTP + Socket.IO + DB pool kapat, sonra exit
// Render / Docker / K8s deploy sırasında bağlantıların temiz kesilmesi için.
// ============================================================
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.warn("Graceful shutdown başlıyor", { signal });

  const FORCE_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

  // Yeni HTTP bağlantısı kabul etme
  try {
    server.close(() => {
      logger.info("HTTP server kapandı");
    });
  } catch (e) {
    logger.warn("server.close hata", { err: e });
  }

  // Socket.IO — mevcut bağlantıları kapat
  try {
    if (io && typeof io.close === "function") {
      io.close(() => {
        logger.info("Socket.IO kapandı");
      });
    }
  } catch (e) {
    logger.warn("io.close hata", { err: e });
  }

  // Canlı maç map'ini temizle (state kaybı kabul edilir; archive zaten yazılmış olmalı)
  try {
    if (liveMatches && typeof liveMatches.clear === "function") {
      liveMatches.clear();
    }
  } catch (_) {}

  // DB pool
  try {
    const { pool } = require("./db");
    if (pool && typeof pool.end === "function") {
      pool
        .end()
        .then(() => logger.info("DB pool kapandı"))
        .catch((e) => logger.warn("pool.end hata", { err: e }));
    }
  } catch (e) {
    logger.warn("db pool end hata", { err: e });
  }

  // Zorunlu çıkış (takılırsa)
  const t = setTimeout(() => {
    logger.fatal("Graceful shutdown zaman aşımı — force exit");
    process.exit(1);
  }, FORCE_MS);
  if (typeof t.unref === "function") t.unref();

  // Normal çıkış için kısa bekleme (close callback'lerinin çalışması)
  setTimeout(() => {
    logger.info("Graceful shutdown tamam", { signal });
    process.exit(0);
  }, Math.min(1500, FORCE_MS / 2)).unref?.();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.fatal("uncaughtException", { err });
  try {
    if (errorTracker && typeof errorTracker.captureException === "function") {
      errorTracker.captureException(err, { tags: ["uncaughtException"] });
    }
  } catch (_) {}
  // Process yarım ölü kalmasın — temiz kapatıp çık
  gracefulShutdown("uncaughtException");
  setTimeout(() => process.exit(1), 2000).unref?.();
});

process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { err: reason });
  try {
    if (errorTracker && typeof errorTracker.captureError === "function") {
      errorTracker.captureError(reason, {
        level: "error",
        tags: ["unhandledRejection"],
      });
    }
  } catch (_) {}
  // Genelde process'i öldürmeyiz; tekrarlayan rejection'lar zaten loglanır.
});

module.exports = { app, server, io, liveMatches };
