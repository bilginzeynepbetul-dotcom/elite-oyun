// ============================================================
// economyBalance.js — Tek kaynaklı ekonomi kalibrasyonu
// ------------------------------------------------------------
// Hedef (orta seviye kulüp, haftalık kabaca):
//   Gelir: 1 ev maçı bilet (~180–280k) + maç primi (~15–100k) + günlük (30k)
//   Gider: kadro maaşı (~180–280k/hf) + antrenör/doktor
//   Transfer: oyuncu değeri ≈ 40–70× haftalık maaş
//   Başlangıç kasa: 5.000.000 (schema)
// ============================================================

/** Başlangıç kasası (schema ile uyumlu — referans) */
const STARTING_BALANCE = 5_000_000;

/** Günlük giriş ödülü */
const DAILY_REWARD = 30_000;

/** Maaş bandı (haftalık €) */
const MIN_WAGE = 400;
const MAX_WAGE = 90_000;

/**
 * Skill ortalaması + yaş + mevki → haftalık maaş.
 * Eski formüle göre ~%15–20 daha düşük (enflasyon freni).
 */
function estimateWageCalibrated(p) {
  if (!p) return MIN_WAGE;
  if (p.wage && Number(p.wage) > 0) {
    return Math.max(MIN_WAGE, Math.min(MAX_WAGE, Math.floor(Number(p.wage))));
  }
  const skills = [
    "pace", "passing", "finishing", "tackle", "vision",
    "stamina", "strength", "technique", "agility", "positioning",
  ];
  const avg =
    skills.reduce((s, k) => s + (Number(p[k]) || 10), 0) / skills.length;
  const age = Number(p.age) || 24;
  const q = Number(p.baseQuality) || Math.round(avg / 2);
  const pot = Number(p.basePotential) || q;

  // avg 12 → ~1000 + 9600 + 3600 + 1500 ≈ 15.7k
  let w = 1000 + avg * 800 + q * 600 + pot * 250;
  if (age <= 21) w *= 0.82;
  else if (age <= 24) w *= 0.95;
  else if (age <= 28) w *= 1.1;
  else if (age <= 32) w *= 1.0;
  else w *= 0.65;

  const pos = (p.pos || p.naturalPos || "").toUpperCase();
  if (pos === "GK") w *= 1.04;
  if (["FC", "FL", "FR"].includes(pos)) w *= 1.06;

  return Math.max(MIN_WAGE, Math.min(MAX_WAGE, Math.round(w / 100) * 100));
}

/**
 * Transfer değeri — maaş ile orantılı (≈ 45–65 haftalık maaş).
 */
function estimatePlayerValueCalibrated(p) {
  const wage = estimateWageCalibrated(p);
  const age = Number(p.age) || 25;
  let yearsFactor = 52;
  if (age <= 21) yearsFactor = 70;
  else if (age <= 24) yearsFactor = 60;
  else if (age >= 30) yearsFactor = 38;
  else if (age >= 33) yearsFactor = 22;

  let v = wage * yearsFactor;
  // Potansiyel primi
  const pot = Number(p.basePotential) || Number(p.potential) || 0;
  if (pot >= 8) v *= 1.12;
  if (pot >= 9) v *= 1.08;

  v = Math.max(25_000, Math.min(25_000_000, v));
  return Math.round(v / 1000) * 1000;
}

/**
 * Maç tipi + sonuç → kulüp nakit primi (her iki taraf için ayrı çağrılır).
 * @param {'league'|'cup'|'friendly'|'continental'|'national_a'|'national_u21'|'instant'} kind
 * @param {'win'|'draw'|'loss'} result
 * @param {{ isHome?: boolean, division?: number }} opts
 */
function matchPrizeMoney(kind, result, opts) {
  opts = opts || {};
  const table = {
    league: { win: 85_000, draw: 35_000, loss: 12_000 },
    cup: { win: 55_000, draw: 18_000, loss: 8_000 },
    continental: { win: 120_000, draw: 45_000, loss: 20_000 },
    friendly: { win: 8_000, draw: 4_000, loss: 2_000 },
    national_a: { win: 0, draw: 0, loss: 0 }, // milli: kulüp kasasına değil
    national_u21: { win: 0, draw: 0, loss: 0 },
    instant: { win: 15_000, draw: 6_000, loss: 3_000 },
  };
  const row = table[kind] || table.friendly;
  let amount = row[result] != null ? row[result] : row.loss;

  // Alt liglerde biraz daha düşük prim
  const div = Number(opts.division) || 1;
  if (kind === "league" && div >= 2) amount = Math.round(amount * 0.75);
  if (kind === "league" && div >= 3) amount = Math.round(amount * 0.6);

  return Math.max(0, Math.floor(amount));
}

/**
 * Maç sonucu her iki kulübe prim yatır.
 * @returns {Promise<{ home: number, away: number }>}
 */
async function applyMatchPrizeMoney(opts) {
  const kind = opts.kind || "league";
  const homeGoals = Number(opts.homeGoals) || 0;
  const awayGoals = Number(opts.awayGoals) || 0;
  const homeClubId = opts.homeClubId;
  const awayClubId = opts.awayClubId;
  const division = opts.division;

  let homeRes = "draw";
  let awayRes = "draw";
  if (homeGoals > awayGoals) {
    homeRes = "win";
    awayRes = "loss";
  } else if (awayGoals > homeGoals) {
    homeRes = "loss";
    awayRes = "win";
  }

  const homeAmt = matchPrizeMoney(kind, homeRes, {
    isHome: true,
    division,
  });
  const awayAmt = matchPrizeMoney(kind, awayRes, {
    isHome: false,
    division,
  });

  const labelBase =
    kind === "league"
      ? "Lig maç primi"
      : kind === "cup"
        ? "Kupa maç primi"
        : kind === "continental"
          ? "Kıtasal maç primi"
          : kind === "instant"
            ? "Anlık maç primi"
            : "Maç primi";

  const clubsRepo = require("./repos/clubsRepo");
  if (homeClubId && homeAmt > 0) {
    await clubsRepo.adjustBalance(
      homeClubId,
      homeAmt,
      labelBase + " (" + homeRes + ")",
    );
  }
  if (awayClubId && awayAmt > 0) {
    await clubsRepo.adjustBalance(
      awayClubId,
      awayAmt,
      labelBase + " (" + awayRes + ")",
    );
  }

  return { home: homeAmt, away: awayAmt, homeRes, awayRes };
}

/** Bilet geliri çarpanları */
const TICKET = {
  DEFAULT_PRICE: 14,
  MIN_PRICE: 6,
  MAX_PRICE: 75,
  BASE_FILL: 0.58,
  FILL_VARIANCE: 0.32,
  // Sonuç doluluk etkisi (ev sahibi)
  WIN_FILL_BONUS: 0.08,
  DRAW_FILL_BONUS: 0.02,
  LOSS_FILL_PENALTY: 0.06,
  CUP_SHARE: 0.55, // kupa/dostluk ev sahibi payı (eski 0.5)
  CONTINENTAL_MULT: 1.25,
  AWAY_SHARE: 0, // deplasman bilet yok
};

/** Stadyum yükseltme */
const STADIUM = {
  DEFAULT_CAPACITY: 22_000,
  SEAT_STEP: 1_000,
  BASE_UPGRADE_COST: 55_000,
  /** Her yükseltmede maliyet çarpanı */
  UPGRADE_COST_GROWTH: 1.08,
  MAX_CAPACITY: 120_000,
};

function stadiumUpgradeCost(totalUpgrades) {
  const n = Math.max(0, Math.floor(Number(totalUpgrades) || 0));
  return Math.round(
    STADIUM.BASE_UPGRADE_COST * Math.pow(STADIUM.UPGRADE_COST_GROWTH, n),
  );
}

/** Altyapı */
const YOUTH = {
  scoutBase: 120_000,
  academyBase: 160_000,
};

function scoutUpgradeCostCalibrated(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  return YOUTH.scoutBase * lv;
}

function academyUpgradeCostCalibrated(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  return YOUTH.academyBase * lv;
}

/** Antrenör maaş (haftalık≈; sistemde aylık/4 kullanılıyor) */
function coachSalaryCalibrated(level) {
  const lv = Math.max(1, Math.min(5, Math.floor(Number(level) || 1)));
  // Biraz düşürüldü
  return Math.round(4_000 + lv * 5_000 + lv * lv * 1_200);
}

/** Özet — debug / admin */
function getEconomySummary() {
  return {
    startingBalance: STARTING_BALANCE,
    dailyReward: DAILY_REWARD,
    wages: { min: MIN_WAGE, max: MAX_WAGE },
    prizes: {
      league: { win: 85_000, draw: 35_000, loss: 12_000 },
      cup: { win: 55_000, draw: 18_000, loss: 8_000 },
      continental: { win: 120_000, draw: 45_000, loss: 20_000 },
      friendly: { win: 8_000, draw: 4_000, loss: 2_000 },
      instant: { win: 15_000, draw: 6_000, loss: 3_000 },
    },
    ticket: TICKET,
    stadium: STADIUM,
    youth: YOUTH,
    notes: [
      "Haftalık maaş ≈ 11–18 oyuncu × 12–20k",
      "Ev maçı bilet + prim ≈ maaş bandını dengeler",
      "Günlük ödül ek nakit (30k)",
      "Stadyum maliyeti her +1000 koltukta %8 artar",
    ],
  };
}

module.exports = {
  STARTING_BALANCE,
  DAILY_REWARD,
  MIN_WAGE,
  MAX_WAGE,
  estimateWageCalibrated,
  estimatePlayerValueCalibrated,
  matchPrizeMoney,
  applyMatchPrizeMoney,
  TICKET,
  STADIUM,
  stadiumUpgradeCost,
  scoutUpgradeCostCalibrated,
  academyUpgradeCostCalibrated,
  coachSalaryCalibrated,
  getEconomySummary,
};
