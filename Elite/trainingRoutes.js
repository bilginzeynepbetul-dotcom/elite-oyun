const express = require("express");
const trainingSystem = require("./trainingSystem");

function createTrainingRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  router.get("/", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      res.json(await trainingSystem.getState(clubId));
    } catch (e) {
      console.error("[training GET]", e);
      res.status(500).json({ error: "Antrenman bilgisi alınamadı" });
    }
  });

  router.post("/player", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { playerId, skill } = req.body || {};
      const result = await trainingSystem.trainPlayer(clubId, playerId, skill);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[training player]", e);
      res.status(500).json({ error: "Antrenman başarısız" });
    }
  });

  router.post("/squad", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const skill = req.body && req.body.skill;
      const result = await trainingSystem.trainSquad(clubId, skill);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[training squad]", e);
      res.status(500).json({ error: "Takım antrenmanı başarısız" });
    }
  });

  router.post("/coach", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { skill, level } = req.body || {};
      const result = await trainingSystem.hireCoach(clubId, skill, level);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[training coach]", e);
      res.status(500).json({ error: "Antrenör işlemi başarısız" });
    }
  });

  router.post("/coach/remove", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const skill = req.body && req.body.skill;
      const result = await trainingSystem.removeCoach(clubId, skill);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[training coach remove]", e);
      res.status(500).json({ error: "Antrenör çıkarılamadı" });
    }
  });

  return router;
}

module.exports = { createTrainingRouter };
