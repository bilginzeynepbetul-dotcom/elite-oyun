// matchArchiveRoutes.js — GET /api/matches/recent, /api/matches/:id
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
