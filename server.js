const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.use(cors());

// Stripe webhook MUST receive the raw body (before express.json()).
// Mounted here so signature verification works.
const { stripeWebhookHandler } = require('./premiumRoutes');
app.post(
  '/api/premium/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

app.use(express.json());

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

// ============================================================
// SOCKET.IO (canlı maç izleme altyapısı)
// ============================================================
let io = null;
try {
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: '*' } });
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
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
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
