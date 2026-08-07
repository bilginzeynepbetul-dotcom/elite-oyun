// ============================================================
// teamRoutes.js — GET/POST /api/team, GET /api/economy
// ------------------------------------------------------------
//   const { createTeamRouter } = require("./teamRoutes");
//   app.use("/api", authMiddleware, createTeamRouter());
// ============================================================

const express = require("express");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./authRoutes");

function createTeamRouter() {
  const router = express.Router();

  // GET /api/team
  router.get("/team", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const team = await clubsRepo.getTeam(clubId);
      if (!team) return res.status(404).json({ error: "Takım yok" });
      res.json({ team });
    } catch (e) {
      console.error("[team GET]", e);
      res.status(500).json({ error: "Takım alınamadı" });
    }
  });

  // POST /api/team  { team: { name, players, bench, gameStyle, ... } }
  router.post("/team", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const team = (req.body && req.body.team) || req.body;
      if (!team || typeof team !== "object") {
        return res.status(400).json({ error: "team gerekli" });
      }
      await clubsRepo.saveTeam(clubId, team);
      const saved = await clubsRepo.getTeam(clubId);
      res.json({ ok: true, team: saved });
    } catch (e) {
      console.error("[team POST]", e);
      res.status(500).json({ error: "Takım kaydedilemedi" });
    }
  });

  // GET /api/economy
  router.get("/economy", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const eco = await clubsRepo.getEconomy(clubId);
      if (!eco) return res.status(404).json({ error: "Ekonomi yok" });
      res.json(eco);
    } catch (e) {
      console.error("[economy]", e);
      res.status(500).json({ error: "Ekonomi alınamadı" });
    }
  });

  return router;
}

module.exports = { createTeamRouter };
