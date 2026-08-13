// ============================================================
// adminSeasonRoutes.js — sezon başlangıcı / fikstür yönetimi
// ------------------------------------------------------------
// Sadece ADMIN_USERNAME (murat)
// ============================================================

const express = require("express");
const seasonConfig = require("./seasonConfig");
const leagueRepo = require("./repos/leagueRepo");
const clubsRepo = require("./repos/clubsRepo");
const { isAdmin } = require("./nationalSystem");
const { enrichClubId } = require("./routes/authRoutes");

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
      let slots;
      try {
        const cal = require("./calendarSchedule");
        slots = cal.slotsForCountry(country);
      } catch (_) {
        slots = await seasonConfig.getLeagueMatchSlots();
      }
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

  // POST /api/admin/full-reset
  // Her şeyi sıfırlar: lig standings/fixtures, oyuncular baştan, milli kuralar otomatik.
  // Tüm kullanıcılar aynı DB durumunu görür.
  router.post("/admin/full-reset", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { query, withTransaction } = require("./db");
      const botClubs = require("./botClubs");
      const nationalSystem = require("./nationalSystem");
      const countriesMod = require("./countries");
      const confirm = req.body && (req.body.confirm === true || req.body.confirm === "yes");
      if (!confirm) {
        return res.status(400).json({
          error: "Onay gerekli: body.confirm = true gönderin. Bu işlem geri alınamaz.",
        });
      }

      const summary = {
        fixturesCleared: 0,
        standingsReset: 0,
        squadsRegenerated: 0,
        seasonsTouched: 0,
        nationalDraws: [],
      };

      // 1) Maç sonuçları / fikstür temizliği (FK sırası)
      try { await query(`DELETE FROM match_logs WHERE TRUE`); } catch (_) {}
      try { await query(`DELETE FROM match_results WHERE TRUE`); } catch (_) {}
      try {
        const r1 = await query(`DELETE FROM fixtures WHERE TRUE`);
        summary.fixturesCleared = r1.rowCount || 0;
      } catch (e) {
        console.warn("[full-reset] fixtures", e.message);
      }
      try { await query(`DELETE FROM national_fixtures WHERE TRUE`); } catch (_) {}
      try { await query(`DELETE FROM cup_fixtures WHERE TRUE`); } catch (_) {}
      try { await query(`DELETE FROM friendly_fixtures WHERE TRUE`); } catch (_) {}

      // 2) Standings sıfırla
      try {
        const r2 = await query(
          `UPDATE league_standings SET played=0, won=0, drawn=0, lost=0, gf=0, ga=0, pts=0`,
        );
        summary.standingsReset = r2.rowCount || 0;
      } catch (e) {
        console.warn("[full-reset] standings", e.message);
      }

      // 3) Oyuncuları baştan ver
      const regen = await botClubs.regenerateAllSquads();
      summary.squadsRegenerated = regen.clubs;

      // 4) Her ülke/lig için fikstür yeniden üret
      const countries = countriesMod.SUPPORTED_COUNTRIES || ["Türkiye"];
      for (const country of countries) {
        for (const division of [1]) {
          try {
            const season = await leagueRepo.ensureSeason(country, division);
            if (!season) continue;
            summary.seasonsTouched++;
            // kulüpleri standings'e ekle
            const { rows: clubs } = await query(
              `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
              [country, division],
            );
            for (const c of clubs) {
              await leagueRepo.ensureClubInStandings(season.id, c.id);
            }
            if (clubs.length >= 2) {
              const startAt = await seasonConfig.getSeasonStartAt();
              const slots = await seasonConfig.getLeagueMatchSlots();
              await leagueRepo.generateFixturesForSeason(season.id, {
                force: true,
                startAt,
                slots,
                bumpPast: false,
                doubleRound: true,
              });
            }
          } catch (e) {
            console.warn("[full-reset] season", country, e.message);
          }
        }
      }

      // 5) Milli kuralar otomatik yeniden çek (tek sefer, paylaşılan)
      for (const cat of ["A", "U21"]) {
        try {
          const draw = await nationalSystem.getOrCreateGroupDraw(cat, true);
          summary.nationalDraws.push({
            category: cat,
            drawnAt: draw.drawnAt,
            groups: (draw.groups || []).map((g) => g.map((t) => t.c)),
          });
        } catch (e) {
          console.warn("[full-reset] national draw", cat, e.message);
        }
      }

      // 6) Youth draw sayaçlarını temizle (mümkünse)
      try {
        const youthSystem = require("./youthSystem");
        if (youthSystem.resetAllSeasonDraws) youthSystem.resetAllSeasonDraws();
      } catch (_) {}

      res.json({ ok: true, message: "Dünya sıfırlandı — tüm kullanıcılar aynı durumu görür", summary });
    } catch (e) {
      console.error("[full-reset]", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createAdminSeasonRouter };
