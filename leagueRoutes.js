// ============================================================
// leagueRoutes.js — standings + fixtures API
// ------------------------------------------------------------
//   const { createLeagueRouter } = require("./leagueRoutes");
//   app.use("/api", authMiddleware, createLeagueRouter());
// ============================================================

const express = require("express");
const leagueRepo = require("./repos/leagueRepo");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const { isAdmin } = require("./nationalSystem");

function createLeagueRouter() {
  const router = express.Router();

  // GET /api/league/standings?country=&division=
  router.get("/league/standings", async (req, res) => {
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
      country = country || "Türkiye";
      division = division || 1;

      const season = await leagueRepo.getCurrentSeason(country, division);
      if (!season) {
        return res.json({ season: null, standings: [] });
      }

      // Ensure user club is on table
      if (clubId) {
        await leagueRepo.ensureClubInStandings(season.id, clubId);
      }

      const standings = await leagueRepo.getStandings(season.id);
      res.json({
        season: {
          id: season.id,
          country: season.country,
          division: season.division,
          yearLabel: season.year_label,
        },
        standings,
      });
    } catch (e) {
      console.error("[standings]", e);
      res.status(500).json({ error: "Puan durumu alınamadı" });
    }
  });

  // GET /api/fixtures
  router.get("/fixtures", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const country = (req.query.country || (club && club.country) || "Türkiye");
      const division = parseInt(
        req.query.division || (club && club.division) || 1,
        10,
      );
      const season = await leagueRepo.getCurrentSeason(country, division);
      if (!season) return res.json({ fixtures: [] });

      const fixtures = await leagueRepo.listFixtures(season.id, {
        status: req.query.status || null,
        clubId: req.query.mine === "1" ? clubId : null,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      });
      res.json({ fixtures, seasonId: season.id });
    } catch (e) {
      console.error("[fixtures]", e);
      res.status(500).json({ error: "Fikstür alınamadı" });
    }
  });

  // GET /api/fixtures/next
  router.get("/fixtures/next", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const club = await clubsRepo.getClub(clubId);
      const fixture = await leagueRepo.getNextFixtureForClub(clubId);
      res.json({
        fixture: fixture || null,
        club: club
          ? { id: club.id, name: club.name }
          : null,
      });
    } catch (e) {
      console.error("[fixtures/next]", e);
      res.status(500).json({ error: "Sıradaki maç alınamadı" });
    }
  });

  // POST /api/league/generate-fixtures  { force?, intervalHours?, doubleRound? }
  // force=true yalnızca admin. Non-admin yalnızca kendi ligi için (boşsa) üretebilir.
  router.post("/league/generate-fixtures", async (req, res) => {
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

      const season = await leagueRepo.getCurrentSeason(country, division);
      if (!season) {
        return res.status(404).json({ error: "Aktif sezon yok" });
      }
      if (clubId) {
        await leagueRepo.ensureClubInStandings(season.id, clubId);
      }

      const wantForce = !!(req.body && req.body.force);
      if (wantForce && !admin) {
        return res.status(403).json({
          error: "Fikstürü zorla yenilemek yalnızca admin yetkisi gerektirir",
        });
      }

      const result = await leagueRepo.generateFixturesForSeason(season.id, {
        force: wantForce && admin,
        intervalHours:
          req.body && req.body.intervalHours != null
            ? req.body.intervalHours
            : 3,
        intervalMinutes:
          req.body && req.body.intervalMinutes != null
            ? req.body.intervalMinutes
            : null,
        doubleRound: req.body && req.body.doubleRound === false ? false : true,
        startAt:
          (req.body && req.body.startAt) ||
          new Date(Date.now() + 2 * 60 * 1000),
      });
      res.json(result);
    } catch (e) {
      console.error("[generate-fixtures]", e);
      res.status(500).json({ error: "Fikstür üretilemedi" });
    }
  });


  return router;
}

module.exports = { createLeagueRouter };

