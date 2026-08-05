// ============================================================
// transferRoutes.js — Express router: /api/transfer/*
// Async transferSystem (getClub/adjustBalance/getTeam/saveTeam)
// ============================================================

const express = require("express");
const transferSystem = require("./transferSystem");

/**
 * @param {{ getClubId: (req) => string|null, getClubName?: (req) => string }} opts
 */
function createTransferRouter(opts) {
  const router = express.Router();
  const getClubId = opts.getClubId;
  const getClubName =
    opts.getClubName ||
    ((req) => (req.user && (req.user.teamName || req.user.username)) || "Kulüp");

  // GET /api/transfer/market?pos=DF
  router.get("/market", async (req, res) => {
    try {
      const clubId = getClubId(req);
      const pos = (req.query.pos || "").toUpperCase() || null;
      const rows = await transferSystem.listMarket(clubId, pos || null);
      res.json({ listings: rows, count: rows.length });
    } catch (e) {
      console.error("[transfer/market]", e);
      res.status(500).json({ error: "Piyasa alınamadı" });
    }
  });

  // POST /api/transfer/bid  { listingId, amount }
  router.post("/bid", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { listingId, amount } = req.body || {};
      const result = await transferSystem.placeBid(
        listingId,
        clubId,
        getClubName(req),
        amount,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[transfer/bid]", e);
      res.status(500).json({ error: "Teklif işlenemedi" });
    }
  });

  // POST /api/transfer/list  { playerId, openPrice, hours, player? }
  router.post("/list", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { playerId, openPrice, hours, player: bodyPlayer } = req.body || {};
      let player = bodyPlayer || null;
      if (!player && playerId) player = { id: playerId };
      if (!player || !player.id) {
        return res.status(400).json({ error: "playerId gerekli" });
      }
      const result = await transferSystem.listPlayerForSale(
        clubId,
        getClubName(req),
        player,
        openPrice,
        hours,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[transfer/list]", e);
      res.status(500).json({ error: "Listeleme başarısız" });
    }
  });

  // POST /api/transfer/cancel  { listingId }
  router.post("/cancel", async (req, res) => {
    try {
      const clubId = getClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const { listingId } = req.body || {};
      const result = await transferSystem.cancelListing(listingId, clubId);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[transfer/cancel]", e);
      res.status(500).json({ error: "İptal başarısız" });
    }
  });

  // POST /api/transfer/refresh
  router.post("/refresh", async (req, res) => {
    try {
      const n = await Promise.resolve(transferSystem.refreshAiMarket());
      res.json({ ok: true, added: n });
    } catch (e) {
      res.status(500).json({ error: "Yenileme başarısız" });
    }
  });

  return router;
}

module.exports = { createTransferRouter };
