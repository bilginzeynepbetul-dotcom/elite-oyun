// ============================================================
// friendlyRoutes.js — /api/friendly/*
// ============================================================

const express = require("express");
const friendlySystem = require("./friendlySystem");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./authRoutes");

function createFriendlyRouter() {
  const router = express.Router();

  router.get("/friendly/eligibility", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const r = await friendlySystem.canPlayFriendly(clubId);
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/friendly", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const list = await friendlySystem.listForClub(clubId);
      res.json({ fixtures: list });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST { awayClubId, kickoffAt } — sen ev sahibisin
  router.post("/friendly/propose", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { awayClubId, kickoffAt } = req.body || {};
      if (!awayClubId || !kickoffAt) {
        return res.status(400).json({ error: "awayClubId ve kickoffAt gerekli" });
      }
      const result = await friendlySystem.propose(
        clubId,
        awayClubId,
        kickoffAt,
        req.user && req.user.id,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[friendly propose]", e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST { fixtureId, accept: true|false }
  router.post("/friendly/respond", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { fixtureId, accept } = req.body || {};
      const result = await friendlySystem.respond(
        fixtureId,
        clubId,
        !!accept,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/friendly/cancel", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const result = await friendlySystem.cancel(
        req.body && req.body.fixtureId,
        clubId,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dostluk için uygun rakipler (kupadan elenen / kupada maçı olmayan)
  router.get("/friendly/opponents", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const me = await clubsRepo.getClub(clubId);
      if (!me) return res.status(404).json({ error: "Kulüp yok" });
      const { query } = require("./db");
      const { rows } = await query(
        `SELECT id, name FROM clubs
         WHERE country = $1 AND division = $2 AND id <> $3
           AND COALESCE(is_bot, FALSE) = FALSE
         ORDER BY name`,
        [me.country, me.division, clubId],
      );
      const out = [];
      for (const c of rows) {
        const el = await friendlySystem.canPlayFriendly(c.id);
        if (el.ok) out.push({ id: c.id, name: c.name });
      }
      res.json({ opponents: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createFriendlyRouter };
