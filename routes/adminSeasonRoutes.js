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

// ---- Duyurular (herkes okur; yalnız admin yazar) ----
// Modül seviyesinde: hem admin router'ı hem de herkese açık router'ı kullanır.
async function loadAnnouncements() {
  try {
    const raw = await seasonConfig.getSetting("announcements", "[]");
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}
async function saveAnnouncements(list) {
  await seasonConfig.setSetting(
    "announcements",
    JSON.stringify(Array.isArray(list) ? list.slice(0, 50) : []),
  );
}

// GET /api/announcements — herkes (isAdmin korumasının DIŞINDA, ayrıca mount edilir)
function createPublicAnnouncementsRouter() {
  const pubRouter = express.Router();
  pubRouter.get("/announcements", async (req, res) => {
    try {
      const announcements = await loadAnnouncements();
      res.json({ announcements });
    } catch (e) {
      console.error("[announcements GET]", e);
      res.status(500).json({ error: "Duyurular alınamadı" });
    }
  });
  return pubRouter;
}

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

  // POST /api/admin/announcements — sadece admin
  router.post("/announcements", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const text = String((req.body && req.body.text) || "").trim().slice(0, 500);
      if (!text) return res.status(400).json({ error: "Metin gerekli" });
      const icon = String((req.body && req.body.icon) || "📢").trim().slice(0, 8) || "📢";
      const now = new Date();
      const time =
        now.toLocaleDateString("tr-TR", {
          day: "2-digit",
          month: "2-digit",
        }) +
        " " +
        now.toLocaleTimeString("tr-TR", {
          hour: "2-digit",
          minute: "2-digit",
        });
      const list = await loadAnnouncements();
      list.unshift({
        id: "a_" + Date.now().toString(36),
        icon,
        text,
        time,
        by: (req.user && req.user.username) || "admin",
      });
      await saveAnnouncements(list.slice(0, 50));
      res.json({ ok: true, announcements: list.slice(0, 50) });
    } catch (e) {
      console.error("[announcements POST]", e);
      res.status(500).json({ error: "Duyuru eklenemedi" });
    }
  });

  // DELETE /api/admin/announcements/:id
  router.delete("/announcements/:id", async (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      const id = String(req.params.id || "");
      let list = await loadAnnouncements();
      list = list.filter((a) => String(a.id) !== id);
      await saveAnnouncements(list);
      res.json({ ok: true, announcements: list });
    } catch (e) {
      console.error("[announcements DELETE]", e);
      res.status(500).json({ error: "Silinemedi" });
    }
  });

  // GET /api/admin/season-config
  router.get("/season-config", async (req, res) => {
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
  router.post("/season-config", async (req, res) => {
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
  router.post("/regenerate-fixtures", async (req, res) => {
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
  router.post("/full-reset", async (req, res) => {
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

      // 1b) Milli istatistikler sıfır — kadrolar + kura kayıtları temiz
      try {
        await query(`DELETE FROM national_squad WHERE TRUE`);
        summary.nationalSquadCleared = true;
      } catch (e) {
        console.warn("[full-reset] national_squad", e.message);
      }
      try {
        await query(
          `DELETE FROM game_settings WHERE key LIKE 'national_group_draw_%'`,
        );
      } catch (_) {}

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

      // 4) Her ülke 1. lig = 10 takım; fikstür yeniden üret
      const countries = countriesMod.SUPPORTED_COUNTRIES || ["Türkiye"];
      summary.leagueFills = [];
      for (const country of countries) {
        for (const division of [1]) {
          try {
            const fill = await botClubs.ensureLeagueFilled({
              country,
              division,
              targetSize: 10,
              generateFixtures: true,
              forceFixtures: true,
            });
            summary.leagueFills.push({
              country,
              division,
              created: (fill && fill.created && fill.created.length) || 0,
              removed: (fill && fill.removed && fill.removed.length) || 0,
            });
            const season = await leagueRepo.ensureSeason(country, division);
            if (!season) continue;
            summary.seasonsTouched++;
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

      // 5) Milli kuralar otomatik yeniden çek (tek sefer, paylaşılan) — sıfırdan
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

module.exports = { createAdminSeasonRouter, createPublicAnnouncementsRouter };
