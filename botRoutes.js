// ============================================================
// botRoutes.js — lig doldurma (bot kulüp)
// ------------------------------------------------------------
//   app.use("/api", authMiddleware, createBotRouter());
// ============================================================

const express = require("express");
const botClubs = require("./botClubs");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const { isAdmin } = require("./nationalSystem");

function createBotRouter() {
  const router = express.Router();

  // POST /api/league/fill-bots
  // { targetSize?: 8, forceFixtures?: false, intervalHours?: 24 }
  // forceFixtures yalnızca admin. Non-admin yalnızca kendi country/division'ına
  // bot ekleyebilir (başka ligleri doldurarak grief edemez).
  router.post("/league/fill-bots", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const admin = isAdmin(req.user && req.user.username);

      let country;
      let division;
      if (admin) {
        country =
          (req.body && req.body.country) ||
          (club && club.country) ||
          "Türkiye";
        division = parseInt(
          (req.body && req.body.division) || (club && club.division) || 1,
          10,
        );
      } else {
        if (!club) {
          return res.status(404).json({ error: "Kulüp yok" });
        }
        country = club.country || "Türkiye";
        division = parseInt(club.division || 1, 10);
      }

      const targetSize = Math.min(
        20,
        Math.max(2, parseInt((req.body && req.body.targetSize) || 8, 10)),
      );

      const wantForce = !!(req.body && req.body.forceFixtures);
      // Non-admin force isteğini yok say: boş ligde üretim yine olur, mevcut fikstür silinmez.
      // (İstemci ensureLeagueReady forceFixtures:true gönderiyor; bu güvenli fallback.)

      const result = await botClubs.ensureLeagueFilled({
        country,
        division,
        targetSize,
        generateFixtures: true,
        forceFixtures: wantForce && admin,
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
