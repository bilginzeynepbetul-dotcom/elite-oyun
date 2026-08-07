// ============================================================
// teamRoutes.js — GET/POST /api/team, GET /api/economy
// ------------------------------------------------------------
//   const { createTeamRouter } = require("./teamRoutes");
//   app.use("/api", authMiddleware, createTeamRouter());
// ============================================================

const express = require("express");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const antiCheat = require("./antiCheat");

function createTeamRouter() {
  const router = express.Router();

  // GET /api/team
  router.get("/team", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const team = await clubsRepo.getTeam(clubId);
      if (!team) return res.status(404).json({ error: "Takım yok" });
      res.json({ team });
    } catch (e) {
      console.error("[team GET]", e);
      res.status(500).json({ error: "Takım alınamadı" });
    }
  });

  // POST /api/team  { team: { name, players, bench, gameStyle, ... } }
  router.post("/team", antiCheat.rateLimitMiddleware({ max: 30, windowMs: 60000, prefix: "team" }), async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      let team = (req.body && req.body.team) || req.body;
      if (!team || typeof team !== "object") {
        return res.status(400).json({ error: "team gerekli" });
      }

      // Anti-cheat: maç sonucu client yazamaz
      const mr = antiCheat.rejectClientMatchResult(req.body);
      if (!mr.ok) {
        await antiCheat.logSuspicious(req.user && req.user.id, clubId, "client_match_result", req.body);
        return res.status(403).json(mr);
      }

      // Mevcut kadro (skill sıçrama kontrolü)
      const existing = await clubsRepo.getTeam(clubId);
      const sanitized = antiCheat.sanitizeTeamPayload(team, existing);
      if (!sanitized.ok) {
        await antiCheat.logSuspicious(req.user && req.user.id, clubId, "team_reject", sanitized);
        return res.status(400).json(sanitized);
      }
      team = sanitized.team;

      // Ciddi skill_jump / overpowered → audit
      const serious = (sanitized.flags || []).filter((f) =>
        f.type === "skill_jump" || f.type === "new_player_overpowered" || f.type === "balance_ignored"
      );
      if (serious.length) {
        await antiCheat.logSuspicious(req.user && req.user.id, clubId, "team_sanitize", {
          flags: serious.slice(0, 20),
        });
      }

      // Takım adı değişiyorsa Elite zorunlu
      if (team.name) {
        const currentName = await clubsRepo.getTeamName(clubId);
        const nextName = String(team.name).trim();
        if (
          currentName &&
          nextName &&
          nextName.toLowerCase() !== String(currentName).toLowerCase()
        ) {
          const premiumSystem = require("./premiumSystem");
          const elite = await premiumSystem.requireElite(req.user && req.user.id);
          if (!elite.ok) {
            team.name = currentName;
            return res.status(403).json({
              ...elite,
              error: "Takım adı değiştirmek Elite üyelik gerektirir",
            });
          }
        }
      }

      await clubsRepo.saveTeam(clubId, team);
      const saved = await clubsRepo.getTeam(clubId);
      res.json({
        ok: true,
        team: saved,
        antiCheat: serious.length ? { adjusted: true, flags: serious.length } : undefined,
      });
    } catch (e) {
      console.error("[team POST]", e);
      res.status(500).json({ error: "Takım kaydedilemedi" });
    }
  });

  // GET /api/economy
  router.get("/economy", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(404).json({ error: "Kulüp yok" });
      const eco = await clubsRepo.getEconomy(clubId);
      if (!eco) return res.status(404).json({ error: "Ekonomi yok" });
      res.json(eco);
    } catch (e) {
      console.error("[economy]", e);
      res.status(500).json({ error: "Ekonomi alınamadı" });
    }
  });

  return router;
}

module.exports = { createTeamRouter };
