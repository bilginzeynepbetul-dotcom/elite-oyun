// ============================================================
// teamUtils.js — shotSystem.js ve ballSystem.js'in ortak kullandığı
// pozisyon/istatistik yardımcıları (tek yerden yönetmek için).
// ============================================================

function posFamily(pos) {
  if (!pos) return "MF";
  if (pos === "GK") return "GK";
  if (["DL", "DR", "DC", "DC2", "SW"].includes(pos)) return "DF";
  if (pos === "DM") return "DM";
  if (["ML", "MR", "MC", "MC2"].includes(pos)) return "MF";
  if (pos === "OMC") return "AM";
  if (["FL", "FR", "FC"].includes(pos)) return "FW";
  return "MF";
}
const isGkPos = (pos) => posFamily(pos) === "GK";
const isFwdPos = (pos) => posFamily(pos) === "FW";
const isDefPos = (pos) => posFamily(pos) === "DF";

function findStriker(team) {
  return (
    team.players.find((p) => isFwdPos(p.pos) && !p.sentOff) ||
    team.players.find((p) => posFamily(p.pos) === "AM" && !p.sentOff) ||
    team.players.find((p) => p.pos !== "GK" && !p.sentOff) ||
    team.players[0]
  );
}

function findGoalkeeper(team) {
  return team.players.find((p) => isGkPos(p.pos)) || team.players[0];
}

function avg(players, key, fallback = 10) {
  if (!players.length) return fallback;
  const sum = players.reduce((acc, p) => acc + (Number(p[key]) || fallback), 0);
  return sum / players.length;
}

/** index-30.html'deki calculateTeamStrength() portu (qBoost/leagueStr hariç) */
function teamStrength(team) {
  const outfield = team.players.filter((p) => p.pos !== "GK" && !p.sentOff);
  if (!outfield.length) return 40;

  const base =
    (avg(outfield, "passing") +
      avg(outfield, "finishing") +
      avg(outfield, "pace") +
      avg(outfield, "technique") +
      avg(outfield, "positioning") +
      avg(outfield, "tackle") +
      avg(outfield, "stamina") +
      avg(outfield, "strength")) /
    8;

  const condFactor = (avg(outfield, "condition", 85) / 100) * 1.15;

  const bonuses = team.matchBonuses || { attack: 0, midfield: 0, defense: 0 };
  const tacticalBoost =
    (bonuses.attack || 0) * 1.8 +
    (bonuses.midfield || 0) * 1.2 +
    (bonuses.defense || 0) * 0.6;

  let styleBoost = 0;
  if (team.gameStyle === "hücumsel") styleBoost = 2.2;
  else if (team.gameStyle === "defansif") styleBoost = -1.2;

  const sentOffCount = team.players.filter((p) => p.sentOff).length;
  const cardPenalty = sentOffCount * 4;

  const raw =
    (base * 4.5 + tacticalBoost + styleBoost - cardPenalty) *
    Math.max(0.55, Math.min(1.2, condFactor));

  return Math.max(25, Math.min(120, raw));
}

// ============================================================
// FORMASYON KOORDİNATLARI (canvas x/y) — index.html'deki
// getHomePositions() ile aynı sıra: mockTeam.js POSITIONS =
// GK,DL,DC,DC2,DR,DM,MC,MC2,OMC,FL,FR
// ============================================================
const FORMATION_SLOTS = [
  { x: 50, y: 200 }, // GK
  { x: 130, y: 50 }, // DL
  { x: 125, y: 140 }, // DC
  { x: 125, y: 260 }, // DC2
  { x: 130, y: 350 }, // DR
  { x: 210, y: 200 }, // DM
  { x: 300, y: 145 }, // MC
  { x: 300, y: 255 }, // MC2
  { x: 410, y: 200 }, // OMC
  { x: 495, y: 55 }, // FL
  { x: 495, y: 345 }, // FR
];
const BENCH_SLOT = { x: 300, y: 200 };

/** Ev sahibi normal, deplasman aynadan (x' = 600 - x) yerleşir. */
function assignFormationPositions(homeTeam, awayTeam) {
  function assign(team, mirror) {
    (team.players || []).forEach((p, i) => {
      const slot = FORMATION_SLOTS[i] || FORMATION_SLOTS[FORMATION_SLOTS.length - 1];
      p.x = mirror ? 600 - slot.x : slot.x;
      p.y = slot.y;
    });
    (team.bench || []).forEach((p) => {
      p.x = mirror ? 600 - BENCH_SLOT.x : BENCH_SLOT.x;
      p.y = BENCH_SLOT.y;
    });
  }
  assign(homeTeam, false);
  assign(awayTeam, true);
}

// ============================================================
// TECRÜBE (1–10 seviye)
// ------------------------------------------------------------
// Eski kayıtlar 0–99 ölçeğinde olabilirdi → otomatik 1–10'a sıkıştırılır.
// Seviye 1 = acemi, 5 = ortalama, 10 = efsane.
// ============================================================
function clampExp(v) {
  const n = Number(v);
  if (!isFinite(n)) return 3;
  return Math.max(1, Math.min(10, n));
}

/** Ham değeri 1–10 aralığına normalize eder (legacy 0–99 destekli). */
function normalizeExperience(raw) {
  let n = Number(raw);
  if (!isFinite(n) || n <= 0) return 3;
  // Eski ölçek: 10'dan büyükse 1–10'a map
  if (n > 10) {
    // 0–99 → 1–10
    n = 1 + (Math.min(99, n) / 99) * 9;
  }
  return clampExp(n);
}

/** Tam sayı seviye 1–10 (UI / etiket). */
function experienceLevel(playerOrValue) {
  const raw =
    playerOrValue != null && typeof playerOrValue === "object"
      ? playerOrValue.experience
      : playerOrValue;
  return Math.round(normalizeExperience(raw));
}

/**
 * Çarpan: seviye 1 → ~0.88, 5 → 1.00, 10 → ~1.14
 * Şut kalitesi, top tutma, kurtarış vb. için.
 */
function experienceFactor(playerOrValue) {
  const lvl = normalizeExperience(
    playerOrValue != null && typeof playerOrValue === "object"
      ? playerOrValue.experience
      : playerOrValue,
  );
  // (lvl - 5) * 0.028 → ±0.14 civarı
  return 1 + (lvl - 5) * 0.028;
}

/** Hata / top kaybı risk çarpanı: yüksek tecrübe → daha az hata (0.82–1.18). */
function experienceErrorFactor(playerOrValue) {
  const lvl = normalizeExperience(
    playerOrValue != null && typeof playerOrValue === "object"
      ? playerOrValue.experience
      : playerOrValue,
  );
  // seviye 10 → 0.82 (az hata), seviye 1 → 1.18
  return 1 - (lvl - 5) * 0.04;
}

/** Takım saha ortalaması tecrübe (1–10). */
function teamAvgExperience(team) {
  const players = (team && team.players) || [];
  let sum = 0;
  let n = 0;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.sentOff || p.pos === "GK") continue;
    sum += normalizeExperience(p.experience);
    n++;
  }
  return n ? sum / n : 5;
}

module.exports = {
  posFamily,
  isGkPos,
  isFwdPos,
  isDefPos,
  findStriker,
  findGoalkeeper,
  avg,
  teamStrength,
  assignFormationPositions,
  clampExp,
  normalizeExperience,
  experienceLevel,
  experienceFactor,
  experienceErrorFactor,
  teamAvgExperience,
};
