// ============================================================
// statsSystem.js — statsRepo sarmalayıcı (matchLifecycle uyumu)
// ============================================================

const statsRepo = require("./repos/statsRepo");

async function recordMatchContributions(opts) {
  return statsRepo.addPlayerMatchContribution(opts);
}

async function topSeason(seasonId, kind, limit) {
  return statsRepo.topSeason(seasonId, kind, limit);
}

async function topMonth(year, month, kind, limit) {
  return statsRepo.topMonth(year, month, kind, limit);
}

module.exports = {
  recordMatchContributions,
  addPlayerMatchContribution: statsRepo.addPlayerMatchContribution,
  topSeason,
  topMonth,
  computePlayerOfMonth: statsRepo.computePlayerOfMonth,
  computeSeasonAwards: statsRepo.computeSeasonAwards,
  listAwards: statsRepo.listAwards,
};
