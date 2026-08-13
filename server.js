const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

// ------------------------------------------------------------
// KRİTİK STABİLİTE DÜZELTMESİ: uygulama Render (ve benzeri) tek
// katmanlı bir reverse proxy'nin arkasında çalışıyor, ama Express
// varsayılan olarak proxy'ye güvenmiyor ("trust proxy" kapalı).
// Bu durumda req.ip HER istekte proxy'nin bağlantı adresine eşit
// oluyor — yani TÜM kullanıcılar aynı "IP" olarak görünüyor.
// Sonuç: login / register / reset-password / security-question ve
// genel /api rate limiter'ları (bkz. routes/authRoutes.js, antiCheat.js)
// IP başına değil, TÜM SİTE için tek ortak sayaç gibi çalışıyor —
// birkaç kullanıcının normal trafiği bile limiti doldurup herkesi
// rastgele 429 ("Çok fazla istek") hatasıyla kilitliyor. PROXY_HOPS
// env değişkeni farklı bir altyapıda (ör. Cloudflare + Render = 2 hop)
// doğru değere ayarlanabilir; varsayılan 1, tek reverse proxy içindir.
const PROXY_HOPS = Number(process.env.PROXY_HOPS || 1);
app.set('trust proxy', PROXY_HOPS);

// ------------------------------------------------------------
// CORS: varsayılan olarak açık (geliştirme). Production'da
// CORS_ORIGIN=https://senin-domain.com şeklinde kısıtla.
// Birden fazla origin için virgülle ayır.
// ------------------------------------------------------------
const corsOriginEnv = (process.env.CORS_ORIGIN || "").trim();
const corsOptions = corsOriginEnv
  ? {
      origin: corsOriginEnv.split(",").map((s) => s.trim()).filter(Boolean),
      credentials: true,
    }
  : { origin: true }; // reflect request origin in dev
app.use(cors(corsOptions));

// Temel güvenlik başlıkları (helmet olmadan)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0"); // modern tarayıcılar CSP kullanır; eski header yanıltıcı
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

// Stripe webhook MUST receive the raw body (before express.json()).
// Mounted here so signature verification works.
const { stripeWebhookHandler } = require('./premiumRoutes');
app.post(
  '/api/premium/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

app.use(express.json({ limit: "256kb" }));

// Global API rate limit
try {
  const { rateLimitMiddleware } = require("./antiCheat");
  app.use("/api/auth", rateLimitMiddleware({ max: 30, windowMs: 60_000, prefix: "auth" }));
  app.use("/api", rateLimitMiddleware({ max: 180, windowMs: 60_000, prefix: "api" }));
  console.log("✅ API rate limit aktif");
} catch (e) {
  console.warn("⚠️  rate limit yüklenemedi:", e.message);
}

// ============================================================
// GÜVENLİK: domain sistemlerini (transfer, altyapı, antrenman,
// stadyum, sosyal) DB repo'larına ve bütçe/roster doğrulamasına bağla.
// Bu çağrı olmadan transferSystem/youthSystem/trainingSystem/stadiumSystem
// "deps" nesnesi boş kalır ve:
//   - transfer teklifleri kulüp bütçesi kontrol edilmeden kabul edilir,
//   - satışa çıkarılan oyuncu istemciden gelen (sahte olabilecek) veriyle
//     doğrudan listelenir, gerçek kadrodan silinmez/doğrulanmaz,
//   - ilanlar/işlemler veritabanına hiç yazılmaz (yeniden başlatmada kaybolur).
// wireAll() bu güvenlik kontrollerini ve kalıcılığı etkinleştirir; sunucu
// istek almadan önce, en başta senkron olarak çağrılmalıdır.
try {
  const { wireAll } = require('./wireSystems');
  wireAll();
  console.log('✅ Domain sistemleri (transfer/youth/training/stadium/social) bağlandı');
} catch (e) {
  console.error('❌ wireSystems başlatılamadı — ekonomi/anti-cheat kontrolleri devre dışı olabilir:', e.message);
}

// ============================================================
// AUTH
// ============================================================
const {
  createAuthRouter,
  authMiddleware,
  meHandler,
  adminResetPasswordHandler,
  enrichClubId,
  socketAuthMiddleware,
} = require('./routes/authRoutes');
// isAdmin middleware bilinçli olarak global /api'ye bağlanmaz (transfer kırılıyordu)
  // const { isAdmin } = require('./authMiddleware');

app.use('/api/auth', createAuthRouter());
app.get('/api/me', authMiddleware, meHandler);
app.post('/api/auth/admin-reset-password', authMiddleware, adminResetPasswordHandler);

// clubId'yi her istekte bir kere doldurup senkron erişilebilir yapar
// (birçok router getClubId(req)'i senkron çağırıyor)
async function attachClubId(req, res, next) {
  try {
    await enrichClubId(req);
  } catch (e) {
    console.warn('[attachClubId]', e.message);
  }
  next();
}

const getClubId = (req) => (req.user && req.user.clubId) || null;
const getUserId = (req) => req.user && req.user.id;
const getUsername = (req) => req.user && req.user.username;

// Tüm oyun içi route'lar için: giriş yapılmış olmalı + clubId dolu olmalı
const gameAuth = [authMiddleware, attachClubId];

// ============================================================
// ADMIN / ANTI-CHEAT
// ============================================================
const adminAntiCheatRoutes = require('./adminAntiCheatRoutes');
app.use('/api/admin/anti-cheat', authMiddleware, adminAntiCheatRoutes);

// Admin ban/unban/user + anket — istemci /api/admin/* yolları
try {
  const { createAdminCompatRouter } = require('./adminCompatRoutes');
  app.use('/api/admin', authMiddleware, createAdminCompatRouter());
  console.log('✅ Admin ban/anket API hazır');
} catch (e) {
  console.warn('⚠️  Admin compat routes:', e.message);
}

// ÖNEMLİ: isAdmin burada TÜM /api isteklerine uygulanmamalı.
  // Aksi halde transfer, lig, takım vb. herkes için "Admin yetkisi gerekli" döner.
  // Admin kontrolü adminSeasonRoutes içinde route bazında yapılıyor.
  const { createAdminSeasonRouter } = require('./adminSeasonRoutes');
  app.use('/api', authMiddleware, createAdminSeasonRouter());

// ============================================================
// TAKIM / EKONOMİ
// ============================================================
const { createTeamRouter } = require('./teamRoutes');
app.use('/api', gameAuth, createTeamRouter());

// ============================================================
// LİG (puan durumu, fikstür)
// ============================================================
const { createLeagueRouter } = require('./leagueRoutes');
app.use('/api', gameAuth, createLeagueRouter());

// ============================================================
// İSTATİSTİK / ÖDÜLLER
// ============================================================
const { createStatsRouter } = require('./statsRoutes');
app.use('/api', gameAuth, createStatsRouter());

// ============================================================
// KUPA
// ============================================================
const { createCupRouter } = require('./cupRoutes');
app.use('/api', gameAuth, createCupRouter());

const { createContinentalRouter } = require('./continentalRoutes');
app.use('/api', gameAuth, createContinentalRouter());

// ============================================================
// TRANSFER
// ============================================================
const { createTransferRouter } = require('./transferRoutes');
app.use('/api/transfer', gameAuth, createTransferRouter({ getClubId }));

// ============================================================
// ALTYAPI / AKADEMİ
// ============================================================
const { createYouthRouter } = require('./youthRoutes');
app.use('/api/youth', gameAuth, createYouthRouter({ getClubId }));

// ============================================================
// ANTRENMAN
// ============================================================
const { createTrainingRouter } = require('./trainingRoutes');
app.use('/api/training', gameAuth, createTrainingRouter({ getClubId }));

// ============================================================
// STADYUM
// ============================================================
const { createStadiumRouter } = require('./stadiumRoutes');
app.use('/api/stadium', gameAuth, createStadiumRouter({ getClubId }));

// ============================================================
// ELİTE / PREMIUM
// ============================================================
const { createPremiumRouter } = require('./premiumRoutes');
app.use('/api/premium', gameAuth, createPremiumRouter());

// ============================================================
// MİLLİ TAKIM
// ============================================================
const { createNationalRouter } = require('./nationalRoutes');
app.use('/api/national', gameAuth, createNationalRouter({ getClubId, getUserId, getUsername }));

// ============================================================
// SOSYAL (forum, mesaj, bildirim)
// ============================================================
const { createSocialRouter } = require('./socialRoutes');
app.use('/api', gameAuth, createSocialRouter({ getUserId, getUsername }));

// ============================================================
// SÖZLEŞMELER
// ============================================================
const { createContractRouter } = require('./contractRoutes');
app.use('/api/contracts', gameAuth, createContractRouter({ getClubId }));

// ============================================================
// HAZIRLIK MAÇLARI
// ============================================================
const { createFriendlyRouter } = require('./friendlyRoutes');
app.use('/api', gameAuth, createFriendlyRouter());

// ============================================================
// BOT KULÜP / LİG DOLDURMA
// ============================================================
const { createBotRouter } = require('./botRoutes');
app.use('/api', gameAuth, createBotRouter());

// ============================================================
// MAÇ ARŞİVİ
// ============================================================
const { createMatchArchiveRouter } = require('./matchArchiveRoutes');
app.use('/api', gameAuth, createMatchArchiveRouter());

// Anlık maç (bot + gerçek kullanıcı)
try {
  const { createInstantMatchRouter } = require('./instantMatchRoutes');
  app.use(
    '/api',
    gameAuth,
    createInstantMatchRouter({
      getIo: () => app.get('io') || null,
      getLiveMatches: () => app.get('liveMatches') || new Map(),
    }),
  );
  console.log('✅ Anlık maç API hazır');
} catch (e) {
  console.warn('⚠️  Anlık maç API yüklenemedi:', e.message);
}

// ============================================================
// SOCKET.IO (canlı maç izleme altyapısı)
// ============================================================
let io = null;
try {
  const { Server } = require('socket.io');
  // Socket CORS: HTTP ile aynı politika (CORS_ORIGIN yoksa dev için açık)
  const socketOrigin = corsOriginEnv
    ? corsOriginEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : true;
  io = new Server(server, { cors: { origin: socketOrigin, credentials: true } });
  io.use(socketAuthMiddleware);

  const liveMatches = new Map(); // fixtureId -> Match instance
  app.set('liveMatches', liveMatches);
  app.set('io', io);

  const { registerMatchControlHandlers } = require('./server-match-socket-handlers');
  registerMatchControlHandlers(
    io,
    (fixtureId) => liveMatches.get(fixtureId) || null,
    (socket) => socket.data && socket.data.user
  );

  // Anlık maç presence + oda
  try {
    const instant = require('./instantMatchSystem');
    const clubsRepo = require('./repos/clubsRepo');
    io.on('connection', (socket) => {
      const user = socket.data && socket.data.user;
      if (user && user.id) {
        socket.join('user:' + user.id);
        (async () => {
          let clubId = null;
          try {
            const club = await clubsRepo.getClubByUserId(user.id);
            clubId = club && club.id;
          } catch (e) {}
          instant.setOnline(user.id, {
            username: user.username || 'Menajer',
            clubId,
            socketId: socket.id,
          });
        })();
      }
      socket.on('fixture:watch', (payload) => {
        try {
          const fid = payload && payload.fixtureId;
          if (fid) {
            socket.join('fixture:' + fid);
            // Maç zaten canlıysa (izleyici sonradan katılıyor/yeniden
            // bağlanıyorsa) mevcut durumu HEMEN gönder — yoksa istemci
            // sunucunun bir sonraki periyodik tick'ine kadar (40 sn'ye
            // kadar) boş sahayla bekliyordu.
            try {
              const m = liveMatches.get(fid);
              if (m && typeof m.getPublicState === 'function') {
                socket.emit('match:state', m.getPublicState(true));
                if (Array.isArray(m.log) && m.log.length) {
                  m.log.slice(-15).forEach((entry) => {
                    socket.emit('match:log', entry);
                  });
                }
                // İki insan maçı: oyuncuya hangi taraf olduğunu bildir
                try {
                  const { resolveSideForUser } = require('./server-match-socket-handlers');
                  const uid = socket.data && socket.data.user && socket.data.user.id;
                  const mySide = resolveSideForUser(m, uid);
                  if (mySide) {
                    socket.emit('match:your-side', {
                      fixtureId: fid,
                      side: mySide,
                      matchId: m.id || fid,
                    });
                  }
                } catch (eSide) {}
              }
            } catch (eState) {}
          }
          const mid = payload && payload.matchId;
          if (mid) {
            socket.join(mid);
            try {
              const m2 = liveMatches.get(mid);
              if (m2 && typeof m2.getPublicState === 'function') {
                socket.emit('match:state', m2.getPublicState(true));
              }
            } catch (eState2) {}
          }
        } catch (e) {}
      });
      socket.on('disconnect', () => {
        if (user && user.id) {
          instant.setOffline(user.id, socket.id);
        }
      });
    });
  } catch (e) {
    console.warn('⚠️  Instant presence socket:', e.message);
  }

  console.log('✅ Socket.IO hazır');

  const { startScheduler } = require('./matchScheduler');
  startScheduler({ io, liveMatches, intervalMs: 15000 });
} catch (e) {
  console.warn('⚠️  Socket.IO kurulamadı (canlı maç izleme devre dışı):', e.message);
  // Socket.IO olmadan da maçlar arka planda simüle edilip sonuçlanabilsin
  try {
    const { startScheduler } = require('./matchScheduler');
    const liveMatchesFallback = new Map();
    app.set('liveMatches', liveMatchesFallback);
    startScheduler({ io: null, liveMatches: liveMatchesFallback, intervalMs: 15000 });
  } catch (e2) {
    console.error('⚠️  Maç zamanlayıcı da başlatılamadı:', e2.message);
  }
}

// ============================================================
// SAĞLIK KONTROLÜ
// ============================================================
app.get('/health', (req, res) => {
  const live = app.get('liveMatches');
  res.json({
    ok: true,
    uptime: process.uptime(),
    liveMatches: live && typeof live.size === 'number' ? live.size : 0,
    ts: Date.now(),
  });
});

// ============================================================
// STATİK ARAYÜZ (public/)
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

// Bilinmeyen /api/* isteği → 404 JSON
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint bulunamadı' });
});

// Diğer tüm yollar → index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hata yakalayıcı
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Sunucu hatası' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server ${PORT} portunda çalışıyor`);
});
