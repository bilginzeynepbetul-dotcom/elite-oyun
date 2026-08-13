const express = require("express");
const stadiumSystem = require("./stadiumSystem");

/**
 * Stadyum API
 *   GET  /api/stadium          → { stadium }
 *   POST /api/stadium/upgrade  → { ok, state, cost? }
 *   POST /api/stadium/ticket   → { ok, state }  body: { price }
 *   POST /api/stadium/rename   → { ok, state }  body: { name }
 */
function createStadiumRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  router.get("/", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const stadium = await stadiumSystem.getState(clubId);
      res.json({ stadium });
    } catch (e) {
      console.error("[stadium GET]", e);
      res.status(500).json({ error: "Stadyum bilgisi alınamadı" });
    }
  });

  router.post("/upgrade", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await stadiumSystem.upgradeSeats(clubId);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[stadium upgrade]", e);
      res.status(500).json({ error: "Yükseltme başarısız" });
    }
  });

  router.post("/ticket", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const price = req.body && req.body.price;
      const result = await stadiumSystem.setTicketPrice(clubId, price);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[stadium ticket]", e);
      res.status(500).json({ error: "Bilet fiyatı güncellenemedi" });
    }
  });

  router.post("/rename", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const name = req.body && req.body.name;
      const result = await stadiumSystem.renameStadium(clubId, name);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[stadium rename]", e);
      res.status(500).json({ error: "İsim güncellenemedi" });
    }
  });

  return router;
}

module.exports = { createStadiumRouter };
