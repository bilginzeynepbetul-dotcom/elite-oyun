// ============================================================
// matchRewards.js — Maç tipi → tecrübe + maç antrenmanı
// ------------------------------------------------------------
// Tecrübe (experience):
//   Sadece maç tipine göre. Tüm oyuncular aynı oran.
//   Yaş / pot / süre / mevki ETKİLEMEZ.
//   milli A / U21  >  lig  >  kupa / dostluk (çok az)  >  kıtasal (0)
//
// Antrenman (skill micro-gain, maç sonu):
//   lig (tam)  >  kupa = dostluk (aynı, daha az)  >  milli / kıtasal (0)
//   pot (basePotential) yüksek → antrenman getirisi yüksek (max pot = max gain)
//   yaş / oynama süresi antrenmanı etkileyebilir
// ============================================================

const { query } = require("./db");

/** @typedef {'league'|'cup'|'friendly'|'national_a'|'national_u21'|'continental'} MatchKind */

const REWARD_TABLE = {
  national_a: {
    experience: 1.0, // en yüksek
    training: 0,
    label: "A Milli",
  },
  national_u21: {
    experience: 0.95, // ümit milli — neredeyse A ile aynı
    training: 0,
    label: "Ümit Milli",
  },
  league: {
    experience: 0.55,
    training: 1.0, // antrenman tam
    label: "Lig",
  },
  cup: {
    experience: 0.12, // çok az tecrübe
    training: 0.30, // dostluk ile aynı antrenman
    label: "Kupa",
  },
  friendly: {
    experience: 0.08, // tecrübe kupa ile benzer (biraz daha az)
    training: 0.30, // kupa ile aynı antrenman
    label: "Dostluk",
  },
  continental: {
    experience: 0, // kıtasal ligde tecrübe yok
    training: 0, // antrenman yok
    label: "Kıtasal",
  },
};

const SKILL_KEYS = [
  "pace",
  "passing",
  "finishing",
  "tackle",
  "vision",
  "stamina",
  "strength",
  "technique",
  "agility",
  "positioning",
  "reflex",
  "handling",
];

function resolvePotential(p) {
  // basePotential / base_potential / potential — 1..10
  let pot =
    Number(p.basePotential) ||
    Number(p.base_potential) ||
    Number(p.potential) ||
    0;
  if (!pot || pot < 1) {
    // Skill ortalamasından kaba tahmin
    const keys = [
      "pace", "passing", "finishing", "tackle", "vision",
      "stamina", "strength", "technique", "agility", "positioning",
    ];
    const avg =
      keys.reduce((s, k) => s + (Number(p[k]) || 10), 0) / keys.length;
    pot = Math.max(1, Math.min(10, Math.round(avg / 2)));
  }
  return Math.max(1, Math.min(10, pot));
}

function getRewardConfig(kind) {
  return REWARD_TABLE[kind] || REWARD_TABLE.friendly;
}

/**
 * Maçta oynayan (starter + oynayan yedek) oyunculara XP + skill uygula.
 * matchInstance: Match — players.home/away.team
 * minutesApprox: oynanan dakika (yoksa 90)
 */
async function applyMatchRewards(opts) {
  const kind = opts.kind || "league";
  const cfg = getRewardConfig(kind);
  const match = opts.matchInstance;
  const state = opts.state;

  if (!cfg.experience && !cfg.training) {
    return { kind, applied: 0, skipped: true, reason: "Bu maç tipinde ödül yok" };
  }
  if (!match || !match.players) {
    return { kind, applied: 0, skipped: true, reason: "Match instance yok" };
  }

  const sides = ["home", "away"];
  let applied = 0;
  const details = [];

  for (const side of sides) {
    const pack = match.players[side];
    if (!pack || !pack.team) continue;
    const team = pack.team;
    const all = [...(team.players || []), ...(team.bench || [])];
    // Maçta süre alanlar: goals/assists veya isStarter veya minutesPlayed
    // Basit: ilk 11 + maç içinde değişenler → goals/assists >0 veya isStarter
    for (const p of all) {
      if (!p || !p.id) continue;
      const played =
        p.isStarter ||
        (Number(p.goals) || 0) > 0 ||
        (Number(p.assists) || 0) > 0 ||
        (Number(p.minutesPlayed) || 0) > 0;
      // Bench hiç oynamadıysa atla (minutes yoksa starter dışı yedekleri düşük XP)
      const isBenchOnly =
        !p.isStarter &&
        !(Number(p.goals) || 0) &&
        !(Number(p.assists) || 0) &&
        !(Number(p.minutesPlayed) || 0);

      // Antrenman için oynama / yaş / pot (tecrübeye YANSIMAZ)
      let playFactor = 1;
      if (isBenchOnly) playFactor = 0.15;
      else if (!p.isStarter) playFactor = 0.7;

      const age = Number(p.age) || 24;
      const ageFactor =
        age <= 21 ? 1.25 : age <= 25 ? 1.1 : age <= 30 ? 1 : age <= 33 ? 0.75 : 0.45;

      const pot = resolvePotential(p);
      // pot 1 → 0.40, pot 10 → 1.30 — sadece antrenman
      const potFactor = 0.4 + (pot / 10) * 0.9;

      // ---- TECRÜBE: sadece maç tipi, herkese aynı ----
      let expGain = 0;
      if (cfg.experience > 0) {
        const baseExp = 0.35;
        // rastgele / yaş / pot / süre YOK
        expGain = baseExp * cfg.experience;
        p.experience = Math.min(99, (Number(p.experience) || 0) + expGain);
      }

      // ---- ANTRENMAN: pot yüksek → daha çok; kupa=dostluk ----
      let skillDeltas = {};
      if (cfg.training > 0 && playFactor >= 0.5) {
        const pos = String(p.pos || p.naturalPos || "MC").toUpperCase();
        let pool = ["stamina", "pace", "technique"];
        if (pos === "GK") pool = ["reflex", "handling", "positioning"];
        else if (["DC", "DL", "DR"].includes(pos))
          pool = ["tackle", "strength", "positioning", "stamina"];
        else if (["MC", "ML", "MR", "DM", "AM"].includes(pos))
          pool = ["passing", "vision", "stamina", "technique"];
        else pool = ["finishing", "pace", "technique", "positioning"];

        const n = cfg.training >= 0.8 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const skill = pool[Math.floor(Math.random() * pool.length)];
          const base = 0.08;
          const gain =
            base *
            cfg.training *
            playFactor *
            ageFactor *
            potFactor *
            (0.85 + Math.random() * 0.3);
          const cur = Number(p[skill]) || 10;
          const next = Math.min(20, cur + gain);
          p[skill] = next;
          skillDeltas[skill] = Math.round((next - cur) * 1000) / 1000;
        }
      }

      // Form: hafif, antrenman/tecrübe maçından (oynama ile)
      if (cfg.experience > 0 || cfg.training > 0) {
        p.form = Math.max(
          -5,
          Math.min(
            10,
            (Number(p.form) || 0) +
              0.15 * playFactor * (cfg.training || cfg.experience),
          ),
        );
      }

      // DB güncelle
      try {
        await persistPlayerRewards(p, skillDeltas, expGain);
        applied++;
        details.push({
          id: p.id,
          name: p.name,
          expGain: Math.round(expGain * 1000) / 1000,
          skills: skillDeltas,
        });
      } catch (e) {
        console.warn("[matchRewards] persist", p.name, e.message);
      }
    }
  }

  return {
    kind,
    label: cfg.label,
    experienceMult: cfg.experience,
    trainingMult: cfg.training,
    applied,
    details: details.slice(0, 8),
  };
}

async function persistPlayerRewards(p, skillDeltas, expGain) {
  const sets = [];
  const params = [];
  let i = 1;

  if (expGain && expGain > 0) {
    sets.push(`experience = LEAST(99, COALESCE(experience, 0) + $${i++})`);
    params.push(expGain);
  }
  if (p.form != null) {
    sets.push(`form = $${i++}`);
    params.push(Number(p.form) || 0);
  }
  for (const [skill, delta] of Object.entries(skillDeltas || {})) {
    if (!SKILL_KEYS.includes(skill) || !delta) continue;
    sets.push(
      `${skill} = LEAST(20, COALESCE(${skill}, 10) + $${i++})`,
    );
    params.push(delta);
  }
  if (!sets.length) return;
  params.push(p.id);
  await query(
    `UPDATE players SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${i}`,
    params,
  );
}

module.exports = {
  REWARD_TABLE,
  getRewardConfig,
  applyMatchRewards,
};
