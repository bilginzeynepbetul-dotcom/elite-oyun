module.exports = {
  MATCH_MINUTES: 90,
  // 1x: 40 sn / oyun dakikası → 90' = 60 gerçek dakika
  TICK_MS: 40000,
  CIRCULATION_MS: 32000,
  // Gol / büyük aksiyon kilidi (gerçek süreye orantılı)
  MAJOR_ACTION_LOCK_MS: 12000,
  // ~90 tick × 0.13 ≈ 12 şut/maç (iki takım toplam)
  SHOT_CHANCE_PER_TICK: 0.13,
};
