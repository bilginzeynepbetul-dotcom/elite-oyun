module.exports = {
  MATCH_MINUTES: 90,
  TICK_MS: 1000,
  CIRCULATION_MS: 800,
  MAJOR_ACTION_LOCK_MS: 2500,
  // ~90 tick × 0.13 ≈ 12 şut/maç (iki takım toplam) → gerçekçi aralık
  SHOT_CHANCE_PER_TICK: 0.13,
};
