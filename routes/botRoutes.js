// ============================================================
// botRoutes.js — lig doldurma (bot kulüp)
// ------------------------------------------------------------
//   app.use("/api", authMiddleware, createBotRouter());
// ============================================================

const express = require("express");
const botClubs = require("./botClubs");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");

function createBotRouter() {
  const router = express.Router();

  // POST /api/league/fill-bots
  // { targetSize?: 8, forceFixtures?: false, intervalHours?: 24 }
  router.post("/league/fill-bots", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const country =
        (req.body && req.body.country) ||
        (club && club.country) ||
        "Türkiye";
      const division = parseInt(
        (req.body && req.body.division) || (club && club.division) || 1,
        10,
      );
      const targetSize = Math.min(
        20,
        Math.max(2, parseInt((req.body && req.body.targetSize) || 10, 10)),
      );

      const result = await botClubs.ensureLeagueFilled({
        country,
        division,
        targetSize,
        generateFixtures: true,
        forceFixtures: !!(req.body && req.body.forceFixtures),
        intervalHours: (req.body && req.body.intervalHours) || 24,
        doubleRound: req.body && req.body.doubleRound === false ? false : true,
      });

      res.json(result);
    } catch (e) {
      console.error("[fill-bots]", e);
      res.status(500).json({ error: e.message || "Bot lig doldurma başarısız" });
    }
  });

  // GET /api/league/club-counts
  router.get("/league/club-counts", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const country =
        req.query.country || (club && club.country) || "Türkiye";
      const division = parseInt(
        req.query.division || (club && club.division) || 1,
        10,
      );
      const total = await botClubs.countClubs(country, division);
      const humans = await botClubs.countHumanClubs(country, division);
      res.json({
        country,
        division,
        total,
        humans,
        bots: total - humans,
      });
    } catch (e) {
      res.status(500).json({ error: "Sayı alınamadı" });
    }
  });

  return router;
}

module.exports = { createBotRouter };
