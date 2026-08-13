// ============================================================
// instantMatchRoutes.js — /api/instant/*
// Bot veya gerçek kullanıcı ile anlık 2D maç
// ============================================================

const express = require("express");
const instant = require("./instantMatchSystem");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const { Match } = require("./matchEngine");

function createInstantMatchRouter(deps) {
  const router = express.Router();
  const getIo = deps && deps.getIo ? deps.getIo : () => null;
  const getLiveMatches =
    deps && deps.getLiveMatches ? deps.getLiveMatches : () => new Map();
  const getUserId = (req) =>
    (req.user && (req.user.id || req.user.userId)) || null;
  const getUsername = (req) =>
    (req.user && (req.user.username || req.user.name)) || "Menajer";

  async function buildPlayer(clubId, userId, username, isBot) {
    const team = await clubsRepo.getTeam(clubId);
    if (!team) throw new Error("Kadro bulunamadı: " + clubId);
    const club = await clubsRepo.getClub(clubId);
    return {
      userId: userId || (club && club.user_id) || null,
      username: username || team.name,
      socketId: null,
      team,
      isBot: !!isBot || !(club && club.user_id),
      clubId,
    };
  }

  function startMatchInstance(homePlayer, awayPlayer, meta) {
    const io = getIo();
    const liveMatches = getLiveMatches();
    const fixtureId = meta.fixtureId || "inst_" + Date.now();
    const matchId = "im_" + fixtureId;
    if (liveMatches.has(fixtureId)) return liveMatches.get(fixtureId);

    const bothBot = !!homePlayer.isBot && !!awayPlayer.isBot;
    // Anlık maç: 90 oyun dakikası ≈ 2.5–3 dk gerçek süre (Elite 2D için ideal)
    // tickMs 1800 → 90*1.8s ≈ 2.7 dk; bot-bot arka planda daha hızlı bitsin
    const tickMs = bothBot ? 400 : 1800;
    const circulationMs = bothBot ? 250 : 1000;
    const match = new Match(matchId, homePlayer, awayPlayer, io, {
      fixtureId,
      tickMs: tickMs,
      circulationMs: circulationMs,
      onEnd: async () => {
        try {
          liveMatches.delete(fixtureId);
        } catch (e) {}
      },
    });
    liveMatches.set(fixtureId, match);
    instant.registerInstantMeta(fixtureId, meta);
    match.start();
    if (io) {
      io.to("fixture:" + fixtureId).emit("fixture:live", {
        fixtureId,
        matchId,
        competition: "instant",
      });
      // Notify participants
      const notify = (userId, payload) => {
        if (!userId || !io) return;
        const u = instant.online.get(String(userId));
        if (u && u.socketId) {
          io.to(u.socketId).emit("instant:match-start", payload);
        }
      };
      const payload = {
        fixtureId,
        matchId,
        home: homePlayer.username,
        away: awayPlayer.username,
        homeClubId: homePlayer.clubId,
        awayClubId: awayPlayer.clubId,
        competition: "instant",
      };
      notify(homePlayer.userId, payload);
      notify(awayPlayer.userId, payload);
    }
    return match;
  }

  // Online presence heartbeat
  router.post("/instant/presence", async (req, res) => {
    try {
      const userId = getUserId(req);
      const clubId = await enrichClubId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      instant.setOnline(userId, {
        username: getUsername(req),
        clubId,
        socketId: null,
      });
      res.json({ ok: true, online: instant.listOnline(userId).length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/instant/online", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      instant.touch(userId);
      res.json({ online: instant.listOnline(userId) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/instant/opponents", async (req, res) => {
    try {
      const userId = getUserId(req);
      const clubId = await enrichClubId(req);
      if (!userId || !clubId)
        return res.status(401).json({ error: "Giriş gerekli" });
      const humans = await instant.listHumanOpponents(clubId, userId);
      res.json({
        opponents: humans,
        online: instant.listOnline(userId),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Hemen bot ile oyna
  router.post("/instant/vs-bot", async (req, res) => {
    try {
      const userId = getUserId(req);
      const clubId = await enrichClubId(req);
      if (!userId || !clubId)
        return res.status(401).json({ error: "Giriş gerekli" });
      const bot = await instant.pickBotOpponent(clubId);
      const home = await buildPlayer(clubId, userId, getUsername(req), false);
      const away = await buildPlayer(bot.id, null, bot.name, true);
      const fixtureId = "inst_bot_" + Date.now() + "_" + Math.floor(Math.random() * 999);
      startMatchInstance(home, away, {
        fixtureId,
        type: "bot",
        homeUserId: userId,
        awayUserId: null,
      });
      res.json({
        ok: true,
        fixtureId,
        matchId: "im_" + fixtureId,
        opponent: { type: "bot", clubId: bot.id, name: bot.name },
        home: home.username,
        away: away.username,
      });
    } catch (e) {
      console.error("[instant vs-bot]", e);
      res.status(400).json({ error: e.message || "Bot maçı başlatılamadı" });
    }
  });

  // Gerçek kullanıcıya teklif
  router.post("/instant/challenge", async (req, res) => {
    try {
      const userId = getUserId(req);
      const clubId = await enrichClubId(req);
      if (!userId || !clubId)
        return res.status(401).json({ error: "Giriş gerekli" });
      const targetUserId = req.body && req.body.targetUserId;
      if (!targetUserId)
        return res.status(400).json({ error: "targetUserId gerekli" });
      let toClubId = req.body && req.body.targetClubId;
      let toUsername = req.body && req.body.targetUsername;
      if (!toClubId) {
        const club = await clubsRepo.getClubByUserId(targetUserId);
        if (!club) return res.status(404).json({ error: "Rakip kulübü yok" });
        toClubId = club.id;
        if (!toUsername) toUsername = club.name;
      }
      const result = instant.createChallenge({
        fromUserId: userId,
        fromUsername: getUsername(req),
        fromClubId: clubId,
        toUserId: targetUserId,
        toUsername: toUsername || "Rakip",
        toClubId,
      });
      if (!result.ok) return res.status(400).json(result);

      const io = getIo();
      if (io) {
        const target = instant.online.get(String(targetUserId));
        if (target && target.socketId) {
          io.to(target.socketId).emit("instant:challenge", result.challenge);
        }
        // also broadcast to user room if any
        io.to("user:" + targetUserId).emit("instant:challenge", result.challenge);
      }
      res.json(result);
    } catch (e) {
      console.error("[instant challenge]", e);
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/instant/pending", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      res.json({ pending: instant.listPendingForUser(userId) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/instant/respond", async (req, res) => {
    try {
      const userId = getUserId(req);
      const clubId = await enrichClubId(req);
      if (!userId || !clubId)
        return res.status(401).json({ error: "Giriş gerekli" });
      const { challengeId, accept } = req.body || {};
      const result = instant.respondChallenge(challengeId, userId, !!accept);
      if (!result.ok) return res.status(400).json(result);

      const c = result.challenge;
      const io = getIo();

      if (!accept) {
        if (io) {
          const from = instant.online.get(String(c.fromUserId));
          if (from && from.socketId) {
            io.to(from.socketId).emit("instant:challenge-result", {
              challengeId: c.id,
              accept: false,
            });
          }
        }
        return res.json({ ok: true, accepted: false, challenge: c });
      }

      // Accept → start match (challenger home)
      const home = await buildPlayer(
        c.fromClubId,
        c.fromUserId,
        c.fromUsername,
        false,
      );
      const away = await buildPlayer(clubId, userId, getUsername(req), false);
      const fixtureId = "inst_pvp_" + c.id;
      startMatchInstance(home, away, {
        fixtureId,
        type: "pvp",
        challengeId: c.id,
        homeUserId: c.fromUserId,
        awayUserId: userId,
      });

      const payload = {
        ok: true,
        accepted: true,
        fixtureId,
        matchId: "im_" + fixtureId,
        home: home.username,
        away: away.username,
        challenge: c,
      };
      if (io) {
        const from = instant.online.get(String(c.fromUserId));
        if (from && from.socketId) {
          io.to(from.socketId).emit("instant:challenge-result", payload);
        }
        io.to("user:" + c.fromUserId).emit("instant:challenge-result", payload);
      }
      res.json(payload);
    } catch (e) {
      console.error("[instant respond]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createInstantMatchRouter };
