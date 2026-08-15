// ============================================================
// teamUtils.js — Pozisyon / formasyon / güç yardımcıları
// ============================================================

function posFamily(pos) {
  const p = String(pos || "").toUpperCase();
  if (p === "GK") return "gk";
  if (["DL", "DC", "DR", "WBL", "WBR"].includes(p)) return "def";
  if (["DM", "MC", "ML", "MR", "OMC", "AML", "AMR", "AMC"].includes(p))
    return "mid";
  if (["FL", "FR", "FC", "ST", "CF"].includes(p)) return "fwd";
  return "mid";
}

function isGkPos(pos) {
  return String(pos || "").toUpperCase() === "GK";
}

function isFwdPos(pos) {
  return posFamily(pos) === "fwd";
}

function avg(nums) {
  const arr = (nums || []).filter((n) => Number.isFinite(Number(n)));
  if (!arr.length) return 10;
  return arr.reduce((s, n) => s + Number(n), 0) / arr.length;
}

function skillOf(p, key, fallback = 10) {
  if (!p) return fallback;
  const v = p[key];
  return Number.isFinite(Number(v)) ? Number(v) : fallback;
}

function teamStrength(team) {
  const players = (team && team.players) || [];
  if (!players.length) return 10;
  const keys = [
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
  ];
  let sum = 0;
  let n = 0;
  for (const p of players) {
    if (!p || p.sentOff || p.injured) continue;
    for (const k of keys) {
      sum += skillOf(p, k);
      n++;
    }
  }
  return n ? sum / n : 10;
}

function teamAvgExperience(team) {
  const players = (team && team.players) || [];
  if (!players.length) return 5;
  let s = 0;
  let n = 0;
  for (const p of players) {
    if (!p) continue;
    s += Number(p.experience) || Number(p.age) || 22;
    n++;
  }
  return n ? s / n : 5;
}

function experienceErrorFactor(team) {
  const exp = teamAvgExperience(team);
  // Genç/tecrübesiz → hata ihtimali biraz daha yüksek
  if (exp < 20) return 1.15;
  if (exp < 24) return 1.05;
  if (exp > 30) return 0.92;
  return 1.0;
}

function findGoalkeeper(team) {
  const players = (team && team.players) || [];
  return players.find((p) => p && isGkPos(p.pos)) || players[0] || null;
}

function findStriker(team) {
  const players = (team && team.players) || [];
  const fwds = players.filter((p) => p && isFwdPos(p.pos) && !p.sentOff);
  if (fwds.length) return fwds[0];
  return players.find((p) => p && !isGkPos(p.pos) && !p.sentOff) || null;
}

/** Basit formasyon slotları (pitch 600x400 varsayımı) */
const FORMATION_SLOTS = {
  "4-4-2": [
    { x: 40, y: 200 },
    { x: 120, y: 50 },
    { x: 115, y: 140 },
    { x: 115, y: 260 },
    { x: 120, y: 350 },
    { x: 220, y: 60 },
    { x: 230, y: 150 },
    { x: 230, y: 250 },
    { x: 220, y: 340 },
    { x: 400, y: 120 },
    { x: 400, y: 280 },
  ],
  "4-3-3": [
    { x: 40, y: 200 },
    { x: 120, y: 50 },
    { x: 115, y: 140 },
    { x: 115, y: 260 },
    { x: 120, y: 350 },
    { x: 240, y: 100 },
    { x: 250, y: 200 },
    { x: 240, y: 300 },
    { x: 420, y: 60 },
    { x: 450, y: 200 },
    { x: 420, y: 340 },
  ],
  "4-2-3-1": [
    { x: 40, y: 200 },
    { x: 120, y: 50 },
    { x: 115, y: 140 },
    { x: 115, y: 260 },
    { x: 120, y: 350 },
    { x: 210, y: 140 },
    { x: 210, y: 260 },
    { x: 320, y: 60 },
    { x: 330, y: 200 },
    { x: 320, y: 340 },
    { x: 460, y: 200 },
  ],
  default: [
    { x: 50, y: 200 },
    { x: 130, y: 50 },
    { x: 125, y: 140 },
    { x: 125, y: 260 },
    { x: 130, y: 350 },
    { x: 210, y: 200 },
    { x: 300, y: 145 },
    { x: 300, y: 255 },
    { x: 410, y: 200 },
    { x: 495, y: 55 },
    { x: 495, y: 345 },
  ],
};

function assignFormationPositions(homeTeam, awayTeam) {
  function place(team, mirror) {
    if (!team || !Array.isArray(team.players)) return;
    const form = (team.formation || "4-4-2").toString();
    const slots = FORMATION_SLOTS[form] || FORMATION_SLOTS.default;
    team.players.forEach((p, i) => {
      if (!p) return;
      const slot = slots[i] || slots[slots.length - 1];
      let x = slot.x;
      let y = slot.y;
      if (mirror) x = 600 - x;
      p.x = x;
      p.y = y;
    });
  }
  place(homeTeam, false);
  place(awayTeam, true);
}

module.exports = {
  posFamily,
  isGkPos,
  isFwdPos,
  avg,
  skillOf,
  teamStrength,
  teamAvgExperience,
  experienceErrorFactor,
  findGoalkeeper,
  findStriker,
  assignFormationPositions,
};
