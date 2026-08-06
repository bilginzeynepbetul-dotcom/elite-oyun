// ============================================================
// adminSeasonRoutes.js — sezon başlangıcı / fikstür yönetimi
// ------------------------------------------------------------
// Sadece ADMIN_USERNAME (murat)
// ============================================================

const express = require("express");
const seasonConfig = require("./seasonConfig");
const leagueRepo = require("./leagueRepo");
const clubsRepo = require("./clubsRepo");
const { isAdmin } = require("./nationalSystem");
const { enrichClubId } = require("./authRoutes");

function createAdminSeasonRouter() {
  const router = express.Router();

  function requireAdmin(req, res) {
    const u = req.user && req.user.username;
    if (!isAdmin(u)) {
      res.status(403).json({ error: "Sadece admin (murat)" });
      return false;
    }
    return true;
  }

  // GET /api/admin/season-config
  router.get("/admin/season-config", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const cfg = await seasonConfig.getConfig();
      res.json(cfg);
    } catch (e) {
      console.error("[season-config GET]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/season-config
  // body: { seasonStartAt: "2026-08-10" | ISO, intervalHours?: number }
  router.post("/admin/season-config", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const body = req.body || {};
      const out = {};
      if (body.seasonStartAt != null) {
        const r = await seasonConfig.setSeasonStartAt(body.seasonStartAt);
        if (!r.ok) return res.status(400).json(r);
        out.seasonStartAt = r.seasonStartAt;
      }
      if (body.leagueMatchSlots != null) {
        const r = await seasonConfig.setLeagueMatchSlots(body.leagueMatchSlots);
        if (!r.ok) return res.status(400).json(r);
        out.leagueMatchSlots = r.slots;
      }
      out.config = await seasonConfig.getConfig();
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("[season-config POST]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/admin/regenerate-fixtures
  // body: { country?, division?, force?: true }
  // force true → scheduled maçları siler, season_start_at'ten yeniden üretir
  router.post("/admin/regenerate-fixtures", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      let country = (req.body && req.body.country) || null;
      let division =
        req.body && req.body.division != null
          ? parseInt(req.body.division, 10)
          : null;
      if (!country || !division) {
        const clubId = await enrichClubId(req);
        if (clubId) {
          const club = await clubsRepo.getClub(clubId);
          if (club) {
            country = country || club.country;
            division = division || club.division;
          }
        }
      }
      country = country || "Türkiye";
      division = division || 1;

      const season = await leagueRepo.getCurrentSeason(country, division);
      if (!season) {
        return res.status(404).json({ error: "Aktif sezon yok" });
      }

      const startAt = await seasonConfig.getSeasonStartAt();
      const slots = await seasonConfig.getLeagueMatchSlots();
      const force = req.body && req.body.force !== false;

      const fx = await leagueRepo.generateFixturesForSeason(season.id, {
        force: !!force,
        startAt,
        slots,
        bumpPast: false,
        doubleRound: true,
      });

      res.json({
        ok: true,
        seasonId: season.id,
        country,
        division,
        startAt: startAt.toISOString(),
        slots,
        scheduleMode: "calendar_slots",
        fixtures: fx,
      });
    } catch (e) {
      console.error("[regenerate-fixtures]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAdminSeasonRouter };
