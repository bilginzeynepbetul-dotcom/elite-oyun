// ============================================================
// contractRoutes.js — /api/contracts/*
// ------------------------------------------------------------
//   app.use("/api/contracts", authMiddleware, createContractRouter({ getClubId }));
// ============================================================

const express = require("express");
const contractSystem = require("./contractSystem");

function createContractRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;

  // GET /api/contracts  — bordro özeti + oyuncu listesi
  router.get("/", async (req, res) => {
    try {
      const clubId = await getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const payroll = await contractSystem.getPayroll(clubId);
      if (!payroll) return res.status(404).json({ error: "Kulüp yok" });
      res.json(payroll);
    } catch (e) {
      console.error("[contracts GET]", e);
      res.status(500).json({ error: "Bordro alınamadı" });
    }
  });

  // POST /api/contracts/renew  { playerId, years, wage }
  router.post("/renew", async (req, res) => {
    try {
      const clubId = await getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { playerId, years, wage } = req.body || {};
      if (!playerId) return res.status(400).json({ error: "playerId gerekli" });
      const result = await contractSystem.renewContract(
        clubId,
        playerId,
        years,
        wage,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[contracts renew]", e);
      res.status(500).json({ error: "Yenileme başarısız" });
    }
  });

  // POST /api/contracts/pay  — manuel bordro (test / admin hissi)
  router.post("/pay", async (req, res) => {
    try {
      const clubId = await getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await contractSystem.payClubWages(clubId);
      if (!result.ok && !result.skipped && !result.unpaid) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e) {
      console.error("[contracts pay]", e);
      res.status(500).json({ error: "Ödeme başarısız" });
    }
  });

  // POST /api/contracts/release-expired
  router.post("/release-expired", async (req, res) => {
    try {
      const clubId = await getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await contractSystem.releaseExpired(clubId);
      res.json(result);
    } catch (e) {
      console.error("[contracts release]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  // POST /api/contracts/release  { playerId }  — tek oyuncuyu serbest bırak
  router.post("/release", async (req, res) => {
    try {
      const clubId = await getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { playerId } = req.body || {};
      if (!playerId) return res.status(400).json({ error: "playerId gerekli" });
      const result = await contractSystem.releasePlayer(clubId, playerId);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[contracts release-one]", e);
      res.status(500).json({ error: "Serbest bırakma başarısız" });
    }
  });

  return router;
}

module.exports = { createContractRouter };
