// ============================================================
// eliteCupRoutes.js — /api/elite-cup/*
// ============================================================

const express = require("express");
const eliteCupRepo = require("./repos/eliteCupRepo");
const { isAdmin } = require("./nationalSystem");
const { enrichClubId } = require("./routes/authRoutes");

function createEliteCupRouter() {
  const router = express.Router();

  router.get("/elite-cup", async (req, res) => {
    try {
      const edition = await eliteCupRepo.getCurrentEdition();
      if (!edition) {
        return res.json({
          edition: null,
          fixtures: [],
          name: "Elite Kupa",
          hint:
            "Elite Kupa 2. sezonda açılır (1. Lig 2. ve 3. sıralar). Bu sezon yok.",
        });
      }
      const fixtures = await eliteCupRepo.getFixtures(edition.id);
      res.json({ edition, fixtures, name: "Elite Kupa" });
    } catch (e) {
      console.error("[elite-cup GET]", e);
      res.status(500).json({ error: "Elite Kupa alınamadı" });
    }
  });

  router.get("/elite-cup/qualifiers", async (req, res) => {
    try {
      const list = await eliteCupRepo.pickQualifiers();
      res.json({ qualifiers: list, count: list.length, name: "Elite Kupa" });
    } catch (e) {
      console.error("[elite-cup/qualifiers]", e);
      res.status(500).json({ error: "Liste alınamadı" });
    }
  });

  router.post("/elite-cup/generate", async (req, res) => {
    try {
      const admin = isAdmin(req.user && req.user.username);
      const force = !!(req.body && req.body.force);
      if (force && !admin) {
        return res.status(403).json({ error: "force sadece admin" });
      }

      const continentalGate = require("./continentalGate");
      const can = await continentalGate.canStartContinentalCompetitions();
      if (!can.ok && !force) {
        return res.json({
          ok: false,
          skipped: true,
          reason: can.reason,
          hint: can.hint,
        });
      }

      const existing = await eliteCupRepo.getCurrentEdition();
      if (existing && !force) {
        return res.json({ ok: true, skipped: true, edition: existing });
      }

      const yearLabel =
        (req.body && req.body.yearLabel) ||
        "EK-" + new Date().getFullYear();
      let startAt;
      try {
        startAt = require("./calendarSchedule").nextWednesday1500TR();
      } catch (_) {
        startAt = new Date();
        startAt.setUTCHours(12, 0, 0, 0);
        while (startAt.getUTCDay() !== 3) {
          startAt = new Date(startAt.getTime() + 86400000);
        }
      }
      const result = await eliteCupRepo.createEdition(yearLabel, { startAt });
      res.json(result);
    } catch (e) {
      console.error("[elite-cup/generate]", e);
      res.status(500).json({ error: e.message || "Oluşturulamadı" });
    }
  });

  router.get("/elite-cup/my", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const edition = await eliteCupRepo.getCurrentEdition();
      if (!edition) return res.json({ edition: null, fixtures: [] });
      const all = await eliteCupRepo.getFixtures(edition.id);
      const fixtures = all.filter(
        (f) =>
          String(f.homeClubId) === String(clubId) ||
          String(f.awayClubId) === String(clubId),
      );
      res.json({ edition, fixtures, name: "Elite Kupa" });
    } catch (e) {
      console.error("[elite-cup/my]", e);
      res.status(500).json({ error: "Alınamadı" });
    }
  });

  return router;
}

module.exports = { createEliteCupRouter };
