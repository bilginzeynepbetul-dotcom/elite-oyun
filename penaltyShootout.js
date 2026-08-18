// ============================================================
// penaltyShootout.js — Penaltı atışları simülasyonu (eleme)
// ------------------------------------------------------------
// FIFA tarzı: 5'er atış (A-B-A-B...), eşitlikte ani ölüm.
// Atıcı finishing/technique + kaleci reflex/positioning kullanır.
// ============================================================

const { findStriker, findGoalkeeper } = require("./teamUtils");

/**
 * Takımdan penaltı sırası: forvet > ofansif orta > diğerleri (GK hariç).
 * En fazla 11 isim; ani ölümde döngüsel kullanılır.
 */
function buildTakerOrder(team) {
  const players = (team && team.players ? team.players.slice() : []).filter(
    (p) => p && !isGk(p),
  );
  const score = (p) => {
    const pos = String(p.pos || "").toUpperCase();
    let role = 0;
    if (/ST|CF|FW|F$/.test(pos)) role = 30;
    else if (/AM|CAM|SS|LW|RW|LM|RM/.test(pos)) role = 20;
    else if (/CM|DM|CDM/.test(pos)) role = 10;
    else role = 5;
    const fin = Number(p.finishing) || 10;
    const tech = Number(p.technique) || 10;
    return role + fin + tech * 0.5;
  };
  players.sort((a, b) => score(b) - score(a));
  if (!players.length) {
    const st = findStriker(team);
    if (st) players.push(st);
  }
  if (!players.length) {
    players.push({ name: "Penaltı", finishing: 12, technique: 11, condition: 90 });
  }
  return players;
}

function isGk(p) {
  const pos = String((p && p.pos) || "").toUpperCase();
  return pos === "GK" || pos === "KL" || pos === "KALECİ";
}

/**
 * Tek penaltı: gol olasılığı ~%55–%85 (beceri + kondisyon + GK).
 * @returns {{ scored: boolean, takerName: string, gkName: string, goalP: number }}
 */
function resolveOnePenalty(taker, gk) {
  const fin = Number(taker.finishing) || 12;
  const tech = Number(taker.technique) || 11;
  const cond = Math.max(0.5, (Number(taker.condition) || 90) / 100);
  const gkRef = Number(gk.reflex) || 12;
  const gkPos = Number(gk.positioning) || 11;
  const gkStr = (gkRef + gkPos) / 40;

  let goalP = 0.58 + ((fin + tech) / 80) * 0.22 - gkStr * 0.14;
  goalP *= 0.9 + cond * 0.1;
  // Hafif rastgele varyans
  goalP += (Math.random() - 0.5) * 0.06;
  goalP = Math.max(0.52, Math.min(0.88, goalP));

  return {
    scored: Math.random() < goalP,
    takerName: taker.name || "Oyuncu",
    gkName: gk.name || "GK",
    goalP,
  };
}

/**
 * Tam penaltı atışı serisi.
 *
 * @param {object} opts
 * @param {object} [opts.homeTeam]
 * @param {object} [opts.awayTeam]
 * @param {string} [opts.homeName]
 * @param {string} [opts.awayName]
 * @param {function} [opts.onKick] - her atış sonrası callback(kick)
 * @returns {{
 *   homeScore: number,
 *   awayScore: number,
 *   winner: 'home'|'away',
 *   kicks: Array,
 *   summary: string
 * }}
 */
function simulatePenaltyShootout(opts) {
  opts = opts || {};
  const homeTeam = opts.homeTeam || {};
  const awayTeam = opts.awayTeam || {};
  const homeName = opts.homeName || homeTeam.name || "Ev";
  const awayName = opts.awayName || awayTeam.name || "Dep";

  const homeTakers = buildTakerOrder(homeTeam);
  const awayTakers = buildTakerOrder(awayTeam);
  const homeGk = findGoalkeeper(awayTeam) || {
    name: "GK",
    reflex: 12,
    positioning: 11,
  };
  // Penaltıda kaleci rakip takımın GK'si
  const awayGk = findGoalkeeper(homeTeam) || {
    name: "GK",
    reflex: 12,
    positioning: 11,
  };
  // home kicks vs awayGk, away kicks vs homeGk
  const gkFor = { home: awayGk, away: homeGk };

  let homeScore = 0;
  let awayScore = 0;
  const kicks = [];
  let round = 0;
  const maxSudden = 20; // güvenlik

  function take(side, index) {
    const list = side === "home" ? homeTakers : awayTakers;
    const taker = list[index % list.length];
    const gk = gkFor[side];
    const r = resolveOnePenalty(taker, gk);
    if (r.scored) {
      if (side === "home") homeScore++;
      else awayScore++;
    }
    const kick = {
      round: round + 1,
      side,
      taker: r.takerName,
      gk: r.gkName,
      scored: r.scored,
      homeScore,
      awayScore,
    };
    kicks.push(kick);
    if (typeof opts.onKick === "function") {
      try {
        opts.onKick(kick);
      } catch (_) {}
    }
    return kick;
  }

  // İlk 5 tur (her taraf 5 atış)
  for (let i = 0; i < 5; i++) {
    round = i;
    take("home", i);
    // Erken bitiş: kalan atışlarla yetişilemezse
    const homeLeft = 5 - (i + 1);
    const awayLeft = 5 - i; // away henüz bu turda atmadı
    if (homeScore > awayScore + awayLeft) break;
    take("away", i);
    const awayLeftAfter = 5 - (i + 1);
    if (awayScore > homeScore + awayLeftAfter) break;
    if (homeScore > awayScore + awayLeftAfter) break;
  }

  // Ani ölüm
  let sudden = 0;
  while (homeScore === awayScore && sudden < maxSudden) {
    const idx = 5 + sudden;
    round = idx;
    take("home", idx);
    take("away", idx);
    sudden++;
  }

  // Teorik olarak hâlâ eşit (maxSudden) — ev sahibine yaz
  if (homeScore === awayScore) homeScore++;

  const winner = homeScore > awayScore ? "home" : "away";
  const summary =
    "Penaltılar " +
    homeScore +
    "-" +
    awayScore +
    " (" +
    (winner === "home" ? homeName : awayName) +
    ")";

  return {
    homeScore,
    awayScore,
    winner,
    kicks,
    summary,
    homeName,
    awayName,
  };
}

module.exports = {
  simulatePenaltyShootout,
  resolveOnePenalty,
  buildTakerOrder,
};
