// ============================================================
// achievementsRoutes.js — GET /api/achievements
// ============================================================

const express = require("express");
const achievementsSystem = require("./achievementsSystem");

function createAchievementsRouter() {
  const router = express.Router();

  // GET /api/achievements — giriş yapan kullanıcının profili
  router.get("/", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const profile = await achievementsSystem.getProfile(userId);
      res.json(profile);
    } catch (e) {
      console.error("[achievements GET]", e);
      res.status(500).json({ error: "Başarılar alınamadı" });
    }
  });

  // GET /api/achievements/defs — tüm tanımlar (auth opsiyonel)
  router.get("/defs", async (req, res) => {
    res.json({ items: achievementsSystem.allDefs() });
  });

  return router;
}

module.exports = { createAchievementsRouter };
