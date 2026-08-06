// ============================================================
// server.example.js — Minimal Express + Socket.IO iskeleti
// ============================================================

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const { wireAll } = require("./wireSystems");
const {
  createAuthRouter,
  authMiddleware,
  meHandler,
  adminResetPasswordHandler,
  socketAuthMiddleware,
} = require("./authRoutes");
const { createTeamRouter } = require("./teamRoutes");
const { createTransferRouter } = require("./transferRoutes");
const { createYouthRouter } = require("./youthRoutes");
const { createTrainingRouter } = require("./trainingRoutes");
const { createStadiumRouter } = require("./stadiumRoutes");
const { createSocialRouter } = require("./socialRoutes");
const { createLeagueRouter } = require("./leagueRoutes");
const { createCupRouter } = require("./cupRoutes");
const { createBotRouter } = require("./botRoutes");
const { createNationalRouter, COUNTRY: NATIONAL_COUNTRY } = require("./nationalRoutes");
const { registerMatchControlHandlers } = require("./server-match-socket-handlers");
const { startFixtureMatch } = require("./matchLifecycle");
const { startCupFixtureMatch } = require("./cupLifecycle");
const { startNationalFixtureMatch } = require("./nationalLifecycle");
const nationalSystem = require("./nationalSystem");
const { Match } = require("./matchEngine");
const leagueRepo = require("./repos/leagueRepo");
const cupRepo = require("./repos/cupRepo");
const nationalRepo = require("./repos/nationalRepo");

const PORT = process.env.PORT || 3000;

async function main() {
  wireAll();

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static("public"));

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });
  io.use(socketAuthMiddleware);

  const liveMatchesByFixture = new Map();

  const autoStartMatch = async (fixtureId) =>
    startFixtureMatch({
      fixtureId,
      io,
      liveMatches: liveMatchesByFixture,
      MatchClass: Match,
    });

  // Kupa maçları da AYNI liveMatchesByFixture Map'ini paylaşır — fixtureId
  // (UUID) lig ve kupa tablolarında ayrı satırlar olduğu için çakışmaz.
  const autoStartCupMatch = async (fixtureId) =>
    startCupFixtureMatch({
      fixtureId,
      io,
      liveMatches: liveMatchesByFixture,
      MatchClass: Match,
    });

  const autoStartNationalMatch = async (fixtureId) =>
    startNationalFixtureMatch({
      fixtureId,
      io,
      liveMatches: liveMatchesByFixture,
      MatchClass: Match,
    });

  // Auth (public)
  app.use("/api/auth", createAuthRouter());

  // Protected
  app.get("/api/me", authMiddleware, meHandler);
  app.post("/api/auth/admin-reset-password", authMiddleware, adminResetPasswordHandler);
  app.use("/api", authMiddleware, createTeamRouter());
  app.use("/api", authMiddleware, createLeagueRouter());
  app.use("/api", authMiddleware, createCupRouter());
  app.use("/api", authMiddleware, createBotRouter());

  const getClubId = (req) => req.user.clubId;
  const getUserId = (req) => req.user.id;
  const getUsername = (req) => req.user.username;
  const getClubName = (req) =>
    (req.user && req.user.username ? req.user.username + " SK" : "Kulüp");

  app.use(
    "/api/national",
    authMiddleware,
    createNationalRouter({ getClubId, getUserId, getUsername }),
  );

  app.use(
    "/api/transfer",
    authMiddleware,
    createTransferRouter({ getClubId, getClubName }),
  );
  app.use("/api/youth", authMiddleware, createYouthRouter({ getClubId }));
  app.use("/api/training", authMiddleware, createTrainingRouter({ getClubId }));
  app.use("/api/stadium", authMiddleware, createStadiumRouter({ getClubId }));
  app.use(
    "/api",
    authMiddleware,
    createSocialRouter({ getUserId, getUsername }),
  );

  app.get("/health", (_req, res) => res.json({ ok: true }));

  registerMatchControlHandlers(
    io,
    (fixtureId) => liveMatchesByFixture.get(fixtureId) || null,
    (socket) => socket.data.user || null,
  );

  io.on("connection", (socket) => {
    socket.on("fixture:watch", async (payload) => {
      try {
        const fixtureId = payload && payload.fixtureId;
        if (!fixtureId) return;
        socket.join("fixture:" + fixtureId);
        socket.join(fixtureId);

        // Kullanıcı maç başlatmaz; sadece izler. Başlatma scheduler'da.
        const match = liveMatchesByFixture.get(fixtureId);
        if (match) {
          socket.emit("match:state", match.getPublicState());
        } else {
          let f = await leagueRepo.getFixtureById(fixtureId);
          if (!f) f = await cupRepo.getFixtureById(fixtureId);
          if (!f) f = await nationalRepo.getFixtureById(fixtureId);
          socket.emit("fixture:status", {
            fixtureId,
            status: f ? f.status : "unknown",
            kickoffAt: f ? f.kickoffAt : null,
          });
        }
      } catch (e) {
        console.error("[fixture:watch]", e.message);
        socket.emit("match:log", {
          minute: 0,
          text: "Maç başlatılamadı: " + e.message,
        });
      }
    });
  });

  setInterval(async () => {
    try {
      const season = await leagueRepo.getCurrentSeason("Türkiye", 1);
      if (!season) return;
      const fixtures = await leagueRepo.listFixtures(season.id, {
        status: "scheduled",
        limit: 20,
      });
      const now = Date.now();
      for (const f of fixtures) {
        const kick = new Date(f.kickoffAt).getTime();
        // Saat geldiyse (veya 30 sn geçmişse) otomatik başlat
        if (kick <= now && !liveMatchesByFixture.has(f.id)) {
          try {
            await autoStartMatch(f.id);
            console.log("[scheduler] auto-started", f.id);
          } catch (e) {
            console.warn("[scheduler]", f.id, e.message);
          }
        }
      }
    } catch (e) {
      console.warn("[scheduler]", e.message);
    }

    // Kupa: saati gelen maçları başlat + bye'lardan sonra takılı kalmasın
    // diye her tick'te tur ilerletmeyi de bir kez kontrol et (bir turun
    // tamamen bye'lardan oluştuğu, hiç canlı maç olmayan durum için).
    try {
      const dueCup = await cupRepo.listDueFixtures(20);
      for (const f of dueCup) {
        if (!liveMatchesByFixture.has(f.id)) {
          try {
            await autoStartCupMatch(f.id);
            console.log("[scheduler] cup auto-started", f.id);
          } catch (e) {
            console.warn("[scheduler] cup", f.id, e.message);
          }
        }
      }
      await cupRepo.advanceReadyEditions();
    } catch (e) {
      console.warn("[scheduler] cup tick", e.message);
    }

    // Milli takım: sırada maç yoksa aç, saati gelmişse başlat.
    try {
      await nationalSystem.scheduleNextFixtureIfNeeded(NATIONAL_COUNTRY);
      const dueNat = await nationalRepo.listDueFixtures(5);
      for (const f of dueNat) {
        if (!liveMatchesByFixture.has(f.id)) {
          try {
            await autoStartNationalMatch(f.id);
            console.log("[scheduler] national auto-started", f.id);
          } catch (e) {
            console.warn("[scheduler] national", f.id, e.message);
          }
        }
      }
    } catch (e) {
      console.warn("[scheduler] national tick", e.message);
    }
  }, 15_000);

  server.listen(PORT, () => {
    console.log("[em] listening on", PORT);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
