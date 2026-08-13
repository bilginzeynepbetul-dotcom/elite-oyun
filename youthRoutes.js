const express = require("express");
const youthSystem = require("./youthSystem");

function createYouthRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  // GET /api/youth
  // Not: hem "youth" (bkz. scripts/smoke.js) hem "state" (bkz.
  // public/multiplayer-client.js fetchYouthFromServer) anahtarı ile
  // aynı state nesnesi döner — iki client tüketicisiyle de uyumlu.
  router.get("/", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const state = await youthSystem.getState(clubId);
      res.json({ youth: state, state });
    } catch (e) {
      console.error("[youth GET]", e);
      res.status(500).json({ error: "Altyapı bilgisi alınamadı" });
    }
  });

  // POST /api/youth/draw  { preferredSkill?, preferredFamily? }
  router.post("/draw", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { preferredSkill, preferredFamily } = req.body || {};
      const result = await youthSystem.drawPlayer(clubId, {
        preferredSkill,
        preferredFamily,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[youth draw]", e);
      res.status(500).json({ error: "Keşif başarısız" });
    }
  });

  // POST /api/youth/upgrade  { kind: "scout" | "academy" }
  router.post("/upgrade", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const kind = req.body && req.body.kind;
      const result = await youthSystem.upgrade(clubId, kind);
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
