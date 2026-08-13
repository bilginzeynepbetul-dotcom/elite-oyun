// ============================================================
// statsRoutes.js — /api/league/stats, /api/league/awards
// ============================================================

const express = require("express");
const statsSystem = require("./statsSystem");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const { isAdmin } = require("./nationalSystem");

function createStatsRouter() {
  const router = express.Router();

  // GET /api/league/stats?country=&division=
  router.get("/league/stats", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      let country = req.query.country;
      let division = req.query.division
        ? parseInt(req.query.division, 10)
        : null;
      if ((!country || !division) && clubId) {
        const club = await clubsRepo.getClub(clubId);
        if (club) {
          country = country || club.country;
          division = division || club.division;
        }
      }
      const data = await statsSystem.getLeaderboards(
        country || "Türkiye",
        division || 1,
      );
      res.json(data);
    } catch (e) {
      console.error("[league/stats]", e);
      res.status(500).json({ error: "İstatistikler alınamadı" });
    }
  });

  // POST /api/league/awards/month  { year, month } — admin
  router.post("/league/awards/month", async (req, res) => {
    try {
      if (!isAdmin(req.user && req.user.username)) {
        return res.status(403).json({ error: "Sadece admin" });
      }
      const now = new Date();
      const year = parseInt(req.body && req.body.year, 10) || now.getFullYear();
      const month =
        parseInt(req.body && req.body.month, 10) || now.getMonth() + 1;
      const winner = await statsSystem.finalizeMonth(year, month);
      res.json({ ok: true, winner });
    } catch (e) {
      console.error("[awards/month]", e);
      res.status(500).json({ error: "Ayın oyuncusu hesaplanamadı" });
    }
  });

  // POST /api/league/awards/season  { seasonId } — admin
  router.post("/league/awards/season", async (req, res) => {
    try {
      if (!isAdmin(req.user && req.user.username)) {
        return res.status(403).json({ error: "Sadece admin" });
      }
      const seasonId = req.body && req.body.seasonId;
      if (!seasonId) return res.status(400).json({ error: "seasonId gerekli" });
      const awards = await statsSystem.finalizeSeason(seasonId);
      res.json({ ok: true, awards });
    } catch (e) {
      console.error("[awards/season]", e);
      res.status(500).json({ error: "Sezon ödülleri hesaplanamadı" });
    }
  });

  return router;
}

module.exports = { createStatsRouter };
