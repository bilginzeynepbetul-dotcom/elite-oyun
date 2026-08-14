// ============================================================
// dailyChallengeRoutes.js — /api/challenges
// ============================================================

const express = require("express");
const dailyChallengeSystem = require("./dailyChallengeSystem");

function createDailyChallengeRouter() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const st = await dailyChallengeSystem.getStatus(req.user && req.user.id);
      res.json(st);
    } catch (e) {
      console.error("[challenges GET]", e);
      res.status(500).json({ error: "Görevler alınamadı" });
    }
  });

  router.post("/claim", async (req, res) => {
    try {
      const id =
        (req.body && (req.body.challengeId || req.body.id)) || "bonus";
      const r = await dailyChallengeSystem.claim(req.user && req.user.id, id);
      if (!r.ok) return res.status(400).json(r);
      res.json(r);
    } catch (e) {
      console.error("[challenges claim]", e);
      res.status(500).json({ error: "Ödül alınamadı" });
    }
  });

  return router;
}

module.exports = { createDailyChallengeRouter };
