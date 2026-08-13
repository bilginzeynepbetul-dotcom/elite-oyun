// ============================================================
// premiumRoutes.js — /api/premium/*
// ============================================================
const express = require("express");
const premiumSystem = require("./premiumSystem");

function createPremiumRouter() {
  const router = express.Router();

  // GET /api/premium/status
  router.get("/status", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      await premiumSystem.ensureTrial(userId);
      const status = await premiumSystem.getStatus(userId);
      res.json({
        status,
        plans: premiumSystem.listPlansPublic(),
        stripeEnabled: premiumSystem.stripeEnabled(),
        mockAllowed:
          process.env.ELITE_ALLOW_MOCK === "1" ||
          process.env.ELITE_ALLOW_MOCK === "true",
      });
    } catch (e) {
      console.error("[premium/status]", e);
      res.status(500).json({ error: "Durum alınamadı" });
    }
  });

  // POST /api/premium/checkout  { plan }
  router.post("/checkout", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      const username = req.user && req.user.username;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const plan = String((req.body && req.body.plan) || "").trim();
      if (!["weekly", "monthly", "yearly"].includes(plan)) {
        return res.status(400).json({ error: "Geçersiz plan" });
      }

      if (premiumSystem.stripeEnabled()) {
        const result = await premiumSystem.createStripeCheckout(
          userId,
          username,
          plan,
          req.body && req.body.successUrl,
          req.body && req.body.cancelUrl,
        );
        if (!result.ok) return res.status(400).json(result);
        return res.json(result);
      }

      // Stripe yok — mock yalnızca ELITE_ALLOW_MOCK açıkken
      const mockAllowed =
        process.env.ELITE_ALLOW_MOCK === "1" ||
        process.env.ELITE_ALLOW_MOCK === "true";
      if (!mockAllowed) {
        return res.status(503).json({
          ok: false,
          error: "Ödeme sistemi yapılandırılmamış (Stripe yok, mock kapalı).",
        });
      }
      res.json({
        ok: true,
        mock: true,
        plan,
        message:
          "Stripe yapılandırılmadı. Demo ortamında Onayla ile aktifleştirebilirsin.",
      });
    } catch (e) {
      console.error("[premium/checkout]", e);
      res.status(500).json({ error: "Ödeme başlatılamadı" });
    }
  });

  // POST /api/premium/confirm-mock  { plan }  — sadece mock / test
  router.post("/confirm-mock", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const plan = String((req.body && req.body.plan) || "").trim();
      const result = await premiumSystem.confirmMockPayment(userId, plan);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[premium/confirm-mock]", e);
      res.status(500).json({ error: "Onay başarısız" });
    }
  });

  // POST /api/premium/sync-trial — denemeyi sunucuda başlat
  router.post("/sync-trial", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const status = await premiumSystem.ensureTrial(userId);
      res.json({ ok: true, status });
    } catch (e) {
      console.error("[premium/sync-trial]", e);
      res.status(500).json({ error: "Deneme başlatılamadı" });
    }
  });


  // GET /api/premium/kit
  router.get("/kit", async (req, res) => {
    try {
      const clubsRepo = require("./repos/clubsRepo");
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const kit = await clubsRepo.getKitDesign(clubId);
      const status = await premiumSystem.getStatus(req.user.id);
      res.json({ kit, canEdit: !!(status && status.active), elite: status });
    } catch (e) {
      console.error("[premium/kit GET]", e);
      res.status(500).json({ error: "Forma alınamadı" });
    }
  });

  // POST /api/premium/kit  { kit } — Elite zorunlu
  router.post("/kit", async (req, res) => {
    try {
      const elite = await premiumSystem.requireElite(req.user.id);
      if (!elite.ok) return res.status(403).json(elite);
      const clubsRepo = require("./repos/clubsRepo");
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const kit = (req.body && req.body.kit) || req.body;
      if (!kit || typeof kit !== "object") {
        return res.status(400).json({ error: "kit gerekli" });
      }
      // Boyut limiti (logo dataURL şişmesin)
      const raw = JSON.stringify(kit);
      if (raw.length > 400000) {
        return res.status(400).json({ error: "Forma verisi çok büyük" });
      }
      await clubsRepo.saveKitDesign(clubId, kit);
      res.json({ ok: true, kit, elite: elite.status });
    } catch (e) {
      console.error("[premium/kit POST]", e);
      res.status(500).json({ error: "Forma kaydedilemedi" });
    }
  });

  // GET /api/premium/second-team
  router.get("/second-team", async (req, res) => {
    try {
      const clubsRepo = require("./repos/clubsRepo");
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const status = await premiumSystem.getStatus(req.user.id);
      const secondTeam = status.active
        ? await clubsRepo.getSecondTeam(clubId)
        : null;
      res.json({
        secondTeam,
        canUse: !!(status && status.active),
        elite: status,
      });
    } catch (e) {
      console.error("[premium/second-team GET]", e);
      res.status(500).json({ error: "İkinci takım alınamadı" });
    }
  });

  // POST /api/premium/second-team  { secondTeam } — Elite zorunlu
  // Kadro verisi antiCheat ile sanitize edilir (aşırı skill / sahte bütçe yok).
  router.post("/second-team", async (req, res) => {
    try {
      const elite = await premiumSystem.requireElite(req.user.id);
      if (!elite.ok) return res.status(403).json(elite);
      const clubsRepo = require("./repos/clubsRepo");
      const antiCheat = require("./antiCheat");
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      let data = (req.body && req.body.secondTeam) || req.body;
      if (!data || typeof data !== "object") {
        return res.status(400).json({ error: "secondTeam gerekli" });
      }
      const raw = JSON.stringify(data);
      if (raw.length > 800000) {
        return res.status(400).json({ error: "Veri çok büyük" });
      }
      // players/bench içeriyorsa ana takım ile aynı sanitizasyon
      if (data.players || data.bench || data.team) {
        const teamLike = data.team || data;
        const existing = await clubsRepo.getSecondTeam(clubId);
        const sanitized = antiCheat.sanitizeTeamPayload(
          teamLike,
          existing && (existing.team || existing),
        );
        if (!sanitized.ok) {
          await antiCheat.logSuspicious(
            req.user && req.user.id,
            clubId,
            "second_team_reject",
            sanitized,
          );
          return res.status(400).json(sanitized);
        }
        if (data.team) data = { ...data, team: sanitized.team };
        else data = sanitized.team;
      }
      await clubsRepo.saveSecondTeam(clubId, data);
      res.json({ ok: true, secondTeam: data, elite: elite.status });
    } catch (e) {
      console.error("[premium/second-team POST]", e);
      res.status(500).json({ error: "İkinci takım kaydedilemedi" });
    }
  });

  // GET /api/premium/daily-status
  router.get("/daily-status", async (req, res) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const st = await premiumSystem.getDailyStatus(userId);
      res.json(st);
    } catch (e) {
      console.error("[premium/daily-status]", e);
      res.status(500).json({ error: "Durum alınamadı" });
    }
  });

  // POST /api/premium/daily-reward — herkes aynı tutar (Elite çarpanı yok)
  router.post("/daily-reward", async (req, res) => {
    try {
      const userId = req.user.id;
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const result = await premiumSystem.claimDailyReward(userId, clubId);
      if (!result.ok) {
        const code = result.code === "ALREADY_CLAIMED" ? 400 : 400;
        return res.status(code).json(result);
      }
      res.json(result);
    } catch (e) {
      console.error("[premium/daily-reward]", e);
      res.status(500).json({ error: "Ödül verilemedi" });
    }
  });

  // POST /api/premium/rename-club  { name } — Elite zorunlu
  router.post("/rename-club", async (req, res) => {
    try {
      const elite = await premiumSystem.requireElite(req.user.id);
      if (!elite.ok) return res.status(403).json(elite);
      const clubsRepo = require("./repos/clubsRepo");
      const { enrichClubId } = require("./routes/authRoutes");
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const name = String((req.body && req.body.name) || "").trim().slice(0, 32);
      if (name.length < 3) {
        return res.status(400).json({ error: "Takım adı en az 3 karakter" });
      }
      const { query } = require("./db");
      await query(`UPDATE clubs SET name = $2 WHERE id = $1`, [clubId, name]);
      res.json({ ok: true, name, elite: elite.status });
    } catch (e) {
      console.error("[premium/rename-club]", e);
      res.status(500).json({ error: "İsim güncellenemedi" });
    }
  });


  return router;
}

/** Stripe webhook — raw body gerekir; server.js ayrı mount eder */
async function stripeWebhookHandler(req, res) {
  try {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !premiumSystem.stripeEnabled()) {
      return res.status(400).json({ error: "Webhook yapılandırılmamış" });
    }
    const Stripe = require("stripe");
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.warn("[stripe webhook] signature", err.message);
      return res.status(400).send("Webhook Error: " + err.message);
    }
    const result = await premiumSystem.handleStripeWebhookEvent(event);
    res.json({ received: true, result });
  } catch (e) {
    console.error("[stripe webhook]", e);
    res.status(500).json({ error: "Webhook işlenemedi" });
  }
}

module.exports = { createPremiumRouter, stripeWebhookHandler };
