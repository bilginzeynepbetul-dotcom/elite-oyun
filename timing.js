// ============================================================
// timing.js — Maç motoru zaman sabitleri
// ============================================================

const MATCH_MINUTES = 90;
const TICK_MS = Number(process.env.MATCH_TICK_MS) || 1800;
const CIRCULATION_MS = Number(process.env.MATCH_CIRCULATION_MS) || 1000;
const MAJOR_ACTION_LOCK_MS = Number(process.env.MATCH_MAJOR_LOCK_MS) || 700;
const SHOT_CHANCE_PER_TICK = Number(process.env.MATCH_SHOT_CHANCE) || 0.12;

module.exports = {
  MATCH_MINUTES,
  TICK_MS,
  CIRCULATION_MS,
  MAJOR_ACTION_LOCK_MS,
  SHOT_CHANCE_PER_TICK,
};
