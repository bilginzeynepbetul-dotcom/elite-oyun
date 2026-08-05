const express = require("express");
const youthSystem = require("./youthSystem");

function createYouthRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  router.get("/", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      res.json({ youth: await youthSystem.getState(clubId) });
    } catch (e) {
      console.error("[youth GET]", e);
      res.status(500).json({ error: "Altyapı alınamadı" });
    }
  });

  router.post("/draw", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const preferredSkill = req.body && req.body.preferredSkill;
      const result = await youthSystem.drawPlayer(clubId, preferredSkill);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[youth draw]", e);
      res.status(500).json({ error: "Oyuncu çekilemedi" });
    }
  });

  router.post("/upgrade", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const kind = (req.body && req.body.kind) || "scout";
      const result = await youthSystem.startUpgrade(clubId, kind);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[youth upgrade]", e);
      res.status(500).json({ error: "Yükseltme başarısız" });
    }
  });

  return router;
}

module.exports = { createYouthRouter };
