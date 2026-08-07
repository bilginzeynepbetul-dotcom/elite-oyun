const express = require("express");
const stadiumSystem = require("./stadiumSystem");

function createStadiumRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  router.get("/", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      res.json({ stadium: await stadiumSystem.getState(clubId) });
    } catch (e) {
      console.error("[stadium/]", e);
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
      console.error("[stadium/upgrade]", e);
      res.status(500).json({ error: "Yükseltme başarısız" });
    }
  });

  router.post("/ticket", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await stadiumSystem.setTicketPrice(
        clubId,
        req.body && req.body.price,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[stadium/ticket]", e);
      res.status(500).json({ error: "Bilet fiyatı güncellenemedi" });
    }
  });

  router.post("/rename", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await stadiumSystem.renameStadium(
        clubId,
        req.body && req.body.name,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[stadium/rename]", e);
      res.status(500).json({ error: "İsim güncellenemedi" });
    }
  });

  return router;
}

module.exports = { createStadiumRouter };
