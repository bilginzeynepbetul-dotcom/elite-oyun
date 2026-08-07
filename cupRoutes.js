// ============================================================
// cupRoutes.js — Kupa API
// ------------------------------------------------------------
//   const { createCupRouter } = require("./cupRoutes");
//   app.use("/api", authMiddleware, createCupRouter());
// ============================================================

const express = require("express");
const cupRepo = require("./repos/cupRepo");
const clubsRepo = require("./repos/clubsRepo");
const matchArchive = require("./matchArchive");
const { enrichClubId } = require("./authRoutes");

function createCupRouter() {
  const router = express.Router();

  // GET /api/cup/stats — kupa gol / asist krallığı (oyuncu + takım)
  router.get("/cup/stats", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 15;
      const data = await matchArchive.getCupKings({ limit });
      res.json({
        goalKing: data.goalKing || [],
        assistKing: data.assistKing || [],
      });
    } catch (e) {
      console.error("[cup/stats]", e);
      res.status(500).json({ error: "Kupa istatistikleri alınamadı" });
    }
  });

  // GET /api/cup/bracket?country=
  router.get("/cup/bracket", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const country = req.query.country || (club && club.country) || "Türkiye";

      const edition = await cupRepo.ensureEditionExists(country);
      if (!edition) {
        return res.json({ edition: null, bracket: [] });
      }
      const bracket = await cupRepo.getBracket(edition.id);
      res.json({ edition, bracket });
    } catch (e) {
      console.error("[cup/bracket]", e);
      res.status(500).json({ error: "Kupa bilgisi alınamadı" });
    }
  });

  // GET /api/cup/next — kullanıcının kulübünün sıradaki kupa maçı
  router.get("/cup/next", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const club = await clubsRepo.getClub(clubId);
      const fixture = await cupRepo.getNextFixtureForClub(clubId);
      res.json({
        fixture: fixture || null,
        club: club ? { id: club.id, name: club.name } : null,
      });
    } catch (e) {
      console.error("[cup/next]", e);
      res.status(500).json({ error: "Sıradaki kupa maçı alınamadı" });
    }
  });

  // POST /api/cup/generate  { country?, force? }
  // Aktif edition yoksa (ya da force=true ve şampiyon belliyse) yeni kupa açar.
  router.post("/cup/generate", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      const club = clubId ? await clubsRepo.getClub(clubId) : null;
      const country = (req.body && req.body.country) || (club && club.country) || "Türkiye";
      const force = !!(req.body && req.body.force);

      const existing = await cupRepo.getCurrentEdition(country);
      if (existing && !force) {
        return res.json({ ok: true, skipped: true, edition: existing });
      }
      if (existing && force) {
        // Mevcut aktif edition'ı kapat, yenisini aç
        const clubIds = await cupRepo.listClubIdsForCountry(country);
        const yearLabel = "force_" + Date.now();
        const result = await cupRepo.createEdition(country, yearLabel, clubIds);
        if (!result.ok) return res.status(400).json({ error: result.error });
        return res.json({ ok: true, ...result });
      }

      const edition = await cupRepo.ensureEditionExists(country);
      res.json({ ok: true, edition });
    } catch (e) {
      console.error("[cup/generate]", e);
      res.status(500).json({ error: "Kupa oluşturulamadı" });
    }
  });

  return router;
}

module.exports = { createCupRouter };
