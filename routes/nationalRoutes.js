// ============================================================
// nationalRoutes.js — /api/national/*
// ============================================================

const express = require("express");
const nationalSystem = require("./nationalSystem");

const COUNTRY = "Türkiye"; // MVP: tek ülke (lig zaten Türkiye)

function readCategory(req) {
  const q = (req.query && req.query.category) || (req.body && req.body.category) || "A";
  return String(q).toUpperCase() === "U21" ? "U21" : "A";
}

function createNationalRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;
  const getUserId = opts.getUserId;
  const getUsername = opts.getUsername;

  router.get("/state", async (req, res) => {
    try {
      const state = await nationalSystem.getState(
        COUNTRY,
        getUserId(req),
        getClubId(req),
        getUsername(req),
        readCategory(req),
      );
      if (!state) return res.status(404).json({ error: "Milli takım bulunamadı" });
      res.json(state);
    } catch (e) {
      console.error("[national/state]", e);
      res.status(500).json({ error: "Milli takım bilgisi alınamadı" });
    }
  });

  // TD koltuğu artık "ilk tıklayan kapar" değil — başvuru + admin ataması.
  router.post("/apply", async (req, res) => {
    try {
      const message = req.body && req.body.message;
      const result = await nationalSystem.apply(
        COUNTRY,
        getUserId(req),
        getClubId(req),
        message,
        getUsername(req),
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/apply]", e);
      res.status(500).json({ error: "Başvuru gönderilemedi" });
    }
  });

  router.post("/apply/withdraw", async (req, res) => {
    try {
      const result = await nationalSystem.withdrawApplication(COUNTRY, getUserId(req), readCategory(req));
      res.json(result);
    } catch (e) {
      console.error("[national/apply/withdraw]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  // Sadece admin (.env ADMIN_USERNAME) görebilir/atayabilir.
  router.get("/applications", async (req, res) => {
    try {
      const result = await nationalSystem.listApplications(COUNTRY, getUsername(req), readCategory(req));
      if (!result.ok) return res.status(403).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/applications]", e);
      res.status(500).json({ error: "Başvurular alınamadı" });
    }
  });

  router.post("/appoint", async (req, res) => {
    try {
      const applicationId = req.body && req.body.applicationId;
      if (!applicationId) return res.status(400).json({ error: "applicationId gerekli" });
      const result = await nationalSystem.appoint(COUNTRY, getUsername(req), applicationId, readCategory(req));
      if (!result.ok) return res.status(403).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/appoint]", e);
      res.status(500).json({ error: "Atama başarısız" });
    }
  });

  router.post("/resign", async (req, res) => {
    try {
      const result = await nationalSystem.resign(COUNTRY, getUserId(req), readCategory(req));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/resign]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  router.post("/squad/call", async (req, res) => {
    try {
      const playerId = req.body && req.body.playerId;
      if (!playerId) return res.status(400).json({ error: "playerId gerekli" });
      const result = await nationalSystem.callUp(COUNTRY, getUserId(req), playerId, readCategory(req));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/call]", e);
      res.status(500).json({ error: "Çağrı başarısız" });
    }
  });

  router.post("/squad/drop", async (req, res) => {
    try {
      const playerId = req.body && req.body.playerId;
      if (!playerId) return res.status(400).json({ error: "playerId gerekli" });
      const result = await nationalSystem.drop(COUNTRY, getUserId(req), playerId, readCategory(req));
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/drop]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  router.post("/squad/lineup", async (req, res) => {
    try {
      const starterPlayerIds = (req.body && req.body.starterPlayerIds) || [];
      const formation = req.body && req.body.formation;
      const assignments = (req.body && req.body.assignments) || [];
      const passStyle = req.body && req.body.passStyle;
      const gameStyle = req.body && req.body.gameStyle;
      const result = await nationalSystem.saveLineup(
        COUNTRY,
        getUserId(req),
        starterPlayerIds,
        formation,
        assignments,
        passStyle,
        gameStyle,
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/lineup]", e);
      res.status(500).json({ error: "Kaydedilemedi" });
    }
  });

  return router;
}

module.exports = { createNationalRouter, COUNTRY };
