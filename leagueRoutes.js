// ============================================================
// leagueRoutes.js — standings + fixtures API
// ------------------------------------------------------------
//   const { createLeagueRouter } = require("./leagueRoutes");
//   app.use("/api", authMiddleware, createLeagueRouter());
// ============================================================

const express = require("express");
const leagueRepo = require("./repos/leagueRepo");
const clubsRepo = require("./repos/clubsRepo");
const statsSystem = require("./statsSystem");
const { enrichClubId } = require("./routes/authRoutes");
const { isAdmin } = require("./nationalSystem");

function createLeagueRouter() {
  const router = express.Router();

  // GET /api/league/stats?country=&division=
  // Sezon ödülleri (goal_king/assist_king/player_of_month vb.) + yıl/ay
  // önizleme sıralamaları. Frontend: window.loadSeasonAwards()
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
      country = country || "Türkiye";
      division = division || 1;

      const season = await leagueRepo.getCurrentSeason(country, division);
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;

      const [awards, playerOfYearPreview, playerOfMonth] = await Promise.all([
        statsSystem
          .listAwards(season ? { seasonId: season.id } : {})
          .catch(() => []),
        season
          ? statsSystem.topSeason(season.id, "goals", 10).catch(() => [])
          : Promise.resolve([]),
        statsSystem.topMonth(year, month, "goals", 10).catch(() => []),
      ]);

      res.json({
        season: season
          ? {
              id: season.id,
              country: season.country,
              division: season.division,
              yearLabel: season.year_label,
            }
          : null,
        month: { year, month },
        awards,
        playerOfYearPreview,
        playerOfMonth,
      });
    } catch (e) {
      console.error("[league/stats]", e);
      res.status(500).json({ error: "İstatistikler alınamadı" });
    }
  });

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



  // GET /api/league/ranking?country=&division=  — çok oyunculu liderlik
  router.get("/league/ranking", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      let country = (req.query && req.query.country) || null;
      let division = req.query && req.query.division
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
        return res.json({ country, division, ranking: [], season: null });
      }
      if (clubId) {
        await leagueRepo.ensureClubInStandings(season.id, clubId);
      }
      const rows = await leagueRepo.getStandings(season.id);
      const ranking = (rows || []).map((r, i) => ({
        rank: i + 1,
        clubId: r.clubId || r.club_id || r.id,
        userId: r.userId || r.user_id || null,
        name: r.name || "Kulüp",
        country: country,
        division: division,
        played: Number(r.played || 0),
        won: Number(r.w || r.won || 0),
        drawn: Number(r.d || r.drawn || 0),
        lost: Number(r.l || r.lost || 0),
        gf: Number(r.gf || 0),
        ga: Number(r.ga || 0),
        pts: Number(r.pts || 0),
        isBot: !!(r.isBot || r.is_bot),
      }));
      res.json({
        country,
        division,
        season: {
          id: season.id,
          yearLabel: season.year_label,
        },
        ranking,
      });
    } catch (e) {
      console.error("[league/ranking]", e);
      res.status(500).json({ error: "Sıralama alınamadı" });
    }
  });

  // GET /api/league/history?country=&division=
  router.get("/league/history", async (req, res) => {
    try {
      const seasonLifecycle = require("./seasonLifecycle");
      const clubsRepo = require("./repos/clubsRepo");
      const { enrichClubId } = require("./routes/authRoutes");
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
      const list = await seasonLifecycle.listSeasonHistory(
        country || "Türkiye",
        division || 1,
        25,
      );
      res.json({
        country: country || "Türkiye",
        division: division || 1,
        seasons: list,
      });
    } catch (e) {
      console.error("[league/history]", e);
      res.status(500).json({ error: "Tarihçe alınamadı" });
    }
  });

  // GET /api/league/season-status?country=&division=
  // UI: kalan maç, sezon tamam mı, şampiyon (varsa)
  router.get("/league/season-status", async (req, res) => {
    try {
      const leagueRepo = require("./repos/leagueRepo");
      const seasonLifecycle = require("./seasonLifecycle");
      const country = (req.query && req.query.country) || "Türkiye";
      const division = req.query && req.query.division
        ? parseInt(req.query.division, 10)
        : 1;
      const season = await leagueRepo.getCurrentSeason(country, division);
      if (!season) {
        return res.json({
          season: null,
          complete: false,
          counts: null,
          message: "Aktif sezon yok",
        });
      }
      const counts = await seasonLifecycle.countFixturesByStatus(season.id);
      const complete = await seasonLifecycle.isSeasonComplete(season.id);
      let seasonMeta = null;
      try {
        seasonMeta = await seasonLifecycle.readSeasonRow(season.id);
      } catch (_) {
        seasonMeta = {
          id: season.id,
          yearLabel: season.year_label || season.yearLabel,
          status: "active",
        };
      }
      const open = (counts.scheduled || 0) + (counts.live || 0);
      res.json({
        season: {
          id: season.id,
          country,
          division,
          yearLabel:
            (seasonMeta && seasonMeta.yearLabel) ||
            season.year_label ||
            season.yearLabel,
          status: (seasonMeta && seasonMeta.status) || "active",
          championName: (seasonMeta && seasonMeta.championName) || null,
        },
        counts,
        open,
        complete,
        message: complete
          ? "Sezon tamamlandı — kapanış bekleniyor veya işlendi"
          : open + " maç kaldı (" + (counts.finished || 0) + " bitti / " + (counts.total || 0) + " toplam)",
      });
    } catch (e) {
      console.error(
        "[league/season-status]",
        e && e.message ? e.message : e,
        e && e.code ? e.code : "",
      );
      res.status(500).json({
        error: "Sezon durumu alınamadı",
        detail: String((e && e.message) || e).slice(0, 200),
      });
    }
  });

  // POST /api/league/finalize-season  { seasonId?, country?, division?, force? }
  router.post("/league/finalize-season", async (req, res) => {
    try {
      const { isAdmin } = require("./nationalSystem");
      if (!isAdmin(req.user && req.user.username)) {
        return res.status(403).json({ error: "Sadece admin" });
      }
      const seasonLifecycle = require("./seasonLifecycle");
      const leagueRepo = require("./repos/leagueRepo");
      let seasonId = req.body && req.body.seasonId;
      if (!seasonId) {
        const country = (req.body && req.body.country) || "Türkiye";
        const division = (req.body && req.body.division) || 1;
        const season = await leagueRepo.getCurrentSeason(country, division);
        if (!season) return res.status(404).json({ error: "Aktif sezon yok" });
        seasonId = season.id;
      }
      const force = !!(req.body && req.body.force);
      if (!force) {
        const done = await seasonLifecycle.isSeasonComplete(seasonId);
        if (!done) {
          const counts = await seasonLifecycle.countFixturesByStatus(seasonId);
          return res.status(400).json({
            error: "Sezon henüz bitmedi (açık maç var)",
            counts,
          });
        }
      }
      // force: kalan scheduled maçları iptal et
      if (force) {
        const { query } = require("./db");
        await query(
          `UPDATE fixtures SET status = 'cancelled'
           WHERE season_id = $1 AND status IN ('scheduled', 'live')`,
          [seasonId],
        );
      }
      const result = await seasonLifecycle.finalizeSeason(seasonId, {
        openNext: true,
        promotion: true,
      });
      res.json(result);
    } catch (e) {
      console.error("[league/finalize-season]", e);
      res.status(500).json({ error: e.message || "Sezon kapatılamadı" });
    }
  });

  return router;
}

module.exports = { createLeagueRouter };

