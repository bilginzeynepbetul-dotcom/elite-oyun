// ============================================================
// nationalRoutes.js — /api/national/*
// Ülke: kullanıcının kulüp ülkesi (yoksa Türkiye)
// ============================================================

const express = require("express");
const nationalSystem = require("./nationalSystem");
const clubsRepo = require("./repos/clubsRepo");

const DEFAULT_COUNTRY = "Türkiye";

function readCategory(req) {
  const q =
    (req.query && req.query.category) ||
    (req.body && req.body.category) ||
    "A";
  return String(q).toUpperCase() === "U21" ? "U21" : "A";
}

async function resolveCountry(req, getClubId) {
  // query/body override (admin / liste)
  const q =
    (req.query && req.query.country) ||
    (req.body && req.body.country) ||
    null;
  if (q && String(q).trim()) return String(q).trim();
  try {
    const clubId = getClubId ? getClubId(req) : null;
    if (clubId) {
      const club = await clubsRepo.getClub(clubId);
      if (club && club.country) return club.country;
    }
  } catch (e) {}
  return DEFAULT_COUNTRY;
}

function createNationalRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;
  const getUserId = opts.getUserId;
  const getUsername = opts.getUsername;

  router.get("/state", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const state = await nationalSystem.getState(
        country,
        getUserId(req),
        getClubId(req),
        getUsername(req),
        readCategory(req),
      );
      if (!state)
        return res.status(404).json({ error: "Milli takım bulunamadı" });
      res.json(state);
    } catch (e) {
      console.error(
        "[national/state]",
        e && e.message ? e.message : e,
        e && e.code ? e.code : "",
      );
      if (e && e.stack) console.error(e.stack);
      res.status(500).json({
        error: "Milli takım bilgisi alınamadı",
        detail: String((e && e.message) || e).slice(0, 300),
        code: e && e.code ? e.code : undefined,
      });
    }
  });

  // Fikstür yoksa A + U21 için dostluk üret
  router.post("/ensure-fixtures", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const out = await nationalSystem.ensureAllNationalFixtures(country);
      res.json({ ok: true, country, fixtures: out });
    } catch (e) {
      console.error("[national/ensure-fixtures]", e);
      res.status(500).json({ error: "Fikstür üretilemedi" });
    }
  });

  // TD koltuğu — başvuru + admin ataması
  router.post("/apply", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const message = req.body && req.body.message;
      const result = await nationalSystem.apply(
        country,
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
      const country = await resolveCountry(req, getClubId);
      const result = await nationalSystem.withdrawApplication(
        country,
        getUserId(req),
        readCategory(req),
      );
      res.json(result);
    } catch (e) {
      console.error("[national/apply/withdraw]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  router.get("/applications", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const result = await nationalSystem.listApplications(
        country,
        getUsername(req),
        readCategory(req),
      );
      if (!result.ok) return res.status(403).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/applications]", e);
      res.status(500).json({ error: "Başvurular alınamadı" });
    }
  });

  router.post("/appoint", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const applicationId = req.body && req.body.applicationId;
      if (!applicationId)
        return res.status(400).json({ error: "applicationId gerekli" });
      const result = await nationalSystem.appoint(
        country,
        getUsername(req),
        applicationId,
        readCategory(req),
      );
      if (!result.ok) return res.status(403).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/appoint]", e);
      res.status(500).json({ error: "Atama başarısız" });
    }
  });

  router.post("/resign", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const result = await nationalSystem.resign(
        country,
        getUserId(req),
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/resign]", e);
      res.status(500).json({ error: "İşlem başarısız" });
    }
  });

  router.post("/squad/call", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const playerId = req.body && req.body.playerId;
      if (!playerId)
        return res.status(400).json({ error: "playerId gerekli" });
      const result = await nationalSystem.callUp(
        country,
        getUserId(req),
        playerId,
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/call]", e);
      res.status(500).json({ error: "Çağrı başarısız" });
    }
  });

  router.post("/squad/drop", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const playerId = req.body && req.body.playerId;
      if (!playerId)
        return res.status(400).json({ error: "playerId gerekli" });
      const result = await nationalSystem.drop(
        country,
        getUserId(req),
        playerId,
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/drop]", e);
      res.status(500).json({ error: "Çıkarma başarısız" });
    }
  });

  router.post("/squad/lineup", async (req, res) => {
    try {
      const country = await resolveCountry(req, getClubId);
      const body = req.body || {};
      const result = await nationalSystem.saveLineup(
        country,
        getUserId(req),
        body.starterPlayerIds || body.starters || [],
        body.formation,
        body.assignments,
        body.passStyle,
        body.gameStyle,
        readCategory(req),
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[national/squad/lineup]", e);
      res.status(500).json({ error: "Kadro kaydedilemedi" });
    }
  });

  // GET /api/national/groups — paylaşılan otomatik kura (tüm kullanıcılar aynı)
  router.get("/groups", async (req, res) => {
    try {
      const cat = readCategory(req);
      const data = await nationalSystem.getOrCreateGroupDraw(cat, false);
      res.json(data);
    } catch (e) {
      console.error("[national/groups]", e);
      res.status(500).json({ error: "Grup kuraları alınamadı" });
    }
  });

  // GET /api/national/ranking
  router.get("/ranking", async (req, res) => {
    try {
      const cat = readCategory(req);
      const ranking = await nationalSystem.buildCountryRankingRows(cat);
      res.json({ category: cat, ranking });
    } catch (e) {
      console.error("[national/ranking]", e);
      res.status(500).json({ error: "Sıralama alınamadı" });
    }
  });

  // GET /api/national/country-profile?country=Türkiye&category=A
  router.get("/country-profile", async (req, res) => {
    try {
      const country =
        (req.query && req.query.country) ||
        (await resolveCountry(req, getClubId));
      const cat = readCategory(req);
      const profile = await nationalSystem.getCountryProfile(country, cat);
      res.json(profile);
    } catch (e) {
      console.error("[national/country-profile]", e);
      res.status(500).json({ error: "Ülke profili alınamadı" });
    }
  });

  return router;
}

module.exports = {
  createNationalRouter,
  COUNTRY: DEFAULT_COUNTRY,
  DEFAULT_COUNTRY,
  resolveCountry,
};
