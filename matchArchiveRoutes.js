// matchArchiveRoutes.js — GET /api/matches/recent, /find, /:id
const express = require("express");
const matchArchive = require("./matchArchive");
const { enrichClubId } = require("./routes/authRoutes");

function createMatchArchiveRouter() {
  const router = express.Router();

  router.get("/matches/recent", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const list = await matchArchive.listRecentForClub(clubId, 15);
      res.json({ matches: list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/matches/find?home=&away=&hg=&ag= — geçmiş skor tıklanınca olay özeti
  router.get("/matches/find", async (req, res) => {
    try {
      const home = (req.query.home || "").trim();
      const away = (req.query.away || "").trim();
      if (!home || !away) {
        return res.status(400).json({ error: "home ve away gerekli" });
      }
      const hg =
        req.query.hg != null && req.query.hg !== ""
          ? parseInt(req.query.hg, 10)
          : null;
      const ag =
        req.query.ag != null && req.query.ag !== ""
          ? parseInt(req.query.ag, 10)
          : null;
      const found = await matchArchive.findByTeamsAndScore(home, away, hg, ag);
      if (!found) return res.json({ match: null, logs: [] });
      const detail = await matchArchive.getMatchDetail(found.id);
      res.json(detail || { match: found, logs: [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/matches/:id", async (req, res) => {
    try {
      const detail = await matchArchive.getMatchDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: "Maç yok" });
      res.json(detail);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createMatchArchiveRouter };
