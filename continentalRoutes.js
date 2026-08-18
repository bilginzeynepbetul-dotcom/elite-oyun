// ============================================================
// continentalRoutes.js — Kıtalar Ligi API
// ============================================================

const express = require("express");
const continentalRepo = require("./repos/continentalRepo");
const clubsRepo = require("./repos/clubsRepo");
const { enrichClubId } = require("./routes/authRoutes");
const { isAdmin } = require("./nationalSystem");

function createContinentalRouter() {
  const router = express.Router();

  // GET /api/continental — edition + groups + fixtures
  router.get("/continental", async (req, res) => {
    try {
      let edition = await continentalRepo.getCurrentEdition();
      let ensureError = null;
      if (!edition && req.query.ensure === "1") {
        try {
          const r = await continentalRepo.ensureEditionExists(
            "CL-" + new Date().getFullYear(),
          );
          edition = r.edition;
          if (!edition && r.error) ensureError = r.error;
        } catch (eEns) {
          ensureError = eEns.message || "CL oluşturulamadı";
          console.warn("[continental ensure]", ensureError);
        }
      }
      if (!edition) {
        let gateHint = null;
        try {
          const gate = require("./continentalGate");
          const can = await gate.canStartContinentalCompetitions();
          if (!can.ok) gateHint = can.hint;
        } catch (_) {}
        return res.json({
          edition: null,
          groups: {},
          fixtures: [],
          pot: [],
          name: "Kıtasal Lig",
          ensureError,
          hint:
            ensureError ||
            gateHint ||
            "Kıtasal Lig 2. sezonda açılır (1. Lig şampiyonları).",
        });
      }
      const [groups, fixtures] = await Promise.all([
        continentalRepo.getGroupStandings(edition.id),
        continentalRepo.getFixtures(edition.id),
      ]);
      res.json({ edition, groups, fixtures });
    } catch (e) {
      console.error("[continental GET]", e);
      res.status(500).json({ error: "Kıtalar Ligi alınamadı" });
    }
  });

  // GET /api/continental/qualifiers — torba önizleme
  router.get("/continental/qualifiers", async (req, res) => {
    try {
      const data = await continentalRepo.pickQualifiers(
        req.query.size ? parseInt(req.query.size, 10) : 8,
      );
      res.json(data);
    } catch (e) {
      console.error("[continental/qualifiers]", e);
      res.status(500).json({ error: "Eleme listesi alınamadı" });
    }
  });

  // POST /api/continental/generate  { force?, yearLabel? }
  router.post("/continental/generate", async (req, res) => {
    try {
      const admin = isAdmin(req.user && req.user.username);
      const force = !!(req.body && req.body.force);
      if (force && !admin) {
        return res.status(403).json({ error: "force sadece admin" });
      }

      const gate = require("./continentalGate");
      const can = await gate.canStartContinentalCompetitions();
      if (!can.ok && !force) {
        return res.json({
          ok: false,
          skipped: true,
          reason: can.reason,
          hint: can.hint,
          name: "Kıtasal Lig",
        });
      }

      const existing = await continentalRepo.getCurrentEdition();
      if (existing && !force) {
        return res.json({ ok: true, skipped: true, edition: existing });
      }
      const yearLabel =
        (req.body && req.body.yearLabel) ||
        "KL-" + new Date().getFullYear();
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
      const result = await continentalRepo.createEdition(yearLabel, {
        startAt,
      });
      res.json(result);
    } catch (e) {
      console.error("[continental/generate]", e);
      res.status(500).json({ error: e.message || "Oluşturulamadı" });
    }
  });

  // GET /api/continental/coefficients — ülke torbası (puan + kontenjan)
  // 2. sezon kupa sonuçlarından birikir; 3. sezondan kontenjan uygulanır.
  router.get("/continental/coefficients", async (req, res) => {
    try {
      const coeff = require("./countryCoefficient");
      const [pot, mode] = await Promise.all([
        coeff.getPot(),
        coeff.getAccessMode(),
      ]);
      res.json({
        name: "Ülke katsayısı torbası",
        mode: mode.mode,
        modeLabel:
          mode.mode === "coefficient"
            ? "3. sezon+ kontenjan aktif"
            : mode.mode === "fixed_s2"
              ? "2. sezon sabit kontenjan (1→Kıtasal, 2+3→Elite)"
              : "Henüz 1. sezon bitmedi",
        slotsRule: [
          { rank: "1–8", total: 7, kitasal: 3, elite: 4 },
          { rank: "9–16", total: 5, kitasal: 2, elite: 3 },
          { rank: "17–40", total: 3, kitasal: 1, elite: 2 },
          { rank: "41+", total: 1, kitasal: 0, elite: 1 },
        ],
        kitasalTarget: 64,
        eliteTarget: 128,
        pot,
        labels: mode.labels,
        countries: mode.countries,
      });
    } catch (e) {
      console.error("[continental/coefficients]", e);
      res.status(500).json({ error: "Torba alınamadı" });
    }
  });

  // GET /api/continental/my — kullanıcının gruptaki durumu
  router.get("/continental/my", async (req, res) => {
    try {
      const clubId = await enrichClubId(req);
      if (!clubId) return res.status(401).json({ error: "Giriş gerekli" });
      const edition = await continentalRepo.getCurrentEdition();
      if (!edition) return res.json({ edition: null, entry: null });
      const groups = await continentalRepo.getGroupStandings(edition.id);
      let entry = null;
      let groupKey = null;
      for (const [g, rows] of Object.entries(groups)) {
        const found = rows.find((r) => String(r.clubId) === String(clubId));
        if (found) {
          entry = found;
          groupKey = g;
          break;
        }
      }
      res.json({ edition, entry, group: groupKey });
    } catch (e) {
      console.error("[continental/my]", e);
      res.status(500).json({ error: "Alınamadı" });
    }
  });

  return router;
}

module.exports = { createContinentalRouter };
