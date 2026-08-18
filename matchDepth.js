// ============================================================
// matchDepth.js — Maç motoru derinlik katmanı
// ------------------------------------------------------------
// 1) Yorgunluk (stamina/condition düşümü — pres + dakika)
// 2) Moral (skor farkı → şut / top kaybı çarpanı)
// 3) Set-piece (korner, serbest vuruş, penaltı)
// 4) Sakatlık / kart riski çarpanları (pres + yorgunluk)
// matchEngine.tick içinden çağrılır; mevcut API'yi bozmaz.
// ============================================================

const { mt } = require("./matchI18n");
const {
  posFamily,
  isGkPos,
  isFwdPos,
  findStriker,
  findGoalkeeper,
  avg,
} = require("./teamUtils");
const { normalizePressIntensity } = require("./tacticNormalize");

/** Maç başında derinlik alanlarını hazırla */
function initMatchDepth(match) {
  if (!match) return;
  match.morale = { home: 50, away: 50 }; // 0–100
  match.depthStats = {
    home: { corners: 0, freeKicks: 0, penalties: 0, avgCondition: 90 },
    away: { corners: 0, freeKicks: 0, penalties: 0, avgCondition: 90 },
  };
  for (const side of ["home", "away"]) {
    const team = match.players[side] && match.players[side].team;
    if (!team) continue;
    (team.players || []).forEach((p) => {
      if (!p) return;
      if (p.condition == null) p.condition = 90 + Math.floor(Math.random() * 8);
      if (p.form == null) p.form = 0; // -5..+5 kariyer formu
      if (p.matchMorale == null) p.matchMorale = 50;
      p._startCondition = Number(p.condition) || 90;
    });
    (team.bench || []).forEach((p) => {
      if (!p) return;
      if (p.condition == null) p.condition = 95;
      if (p.form == null) p.form = 0;
    });
  }
  recomputeMorale(match);
}

/**
 * Dakika başı yorgunluk.
 * Yüksek pres, düşük stamina, fazla koşu pozisyonu → daha hızlı düşüş.
 */
function applyFatigueTick(match) {
  if (!match || match.status !== "live") return;
  const minute = Number(match.minute) || 0;
  // İlk 10' ve devre arası sonrası hafif toparlanma hissi
  const lateFactor = minute < 15 ? 0.55 : minute < 60 ? 1.0 : minute < 75 ? 1.25 : 1.55;

  for (const side of ["home", "away"]) {
    const pSide = match.players[side];
    if (!pSide || !pSide.team) continue;
    const team = pSide.team;
    let press = "orta";
    try {
      press = normalizePressIntensity(team.pressIntensity, "orta");
    } catch (_) {}
    const pressMul = press === "yüksek" ? 1.35 : press === "düşük" ? 0.75 : 1.0;
    // Gerideyse ekstra efor
    const other = side === "home" ? "away" : "home";
    const diff =
      (match.score[side] || 0) - (match.score[other] || 0);
    const chaseMul = diff <= -2 ? 1.2 : diff < 0 ? 1.08 : 1.0;

    let condSum = 0;
    let n = 0;
    (team.players || []).forEach((pl) => {
      if (!pl || pl.sentOff || pl.injured) return;
      const sta = Math.max(1, Number(pl.stamina) || 10);
      const fam = posFamily(pl.pos);
      // GK daha az koşar
      const posMul =
        isGkPos(pl.pos) ? 0.35 : fam === "fwd" ? 1.15 : fam === "mid" ? 1.1 : 1.0;
      // Temel düşüş ~0.12–0.35 / dk (90'da stamina 12 → ~15–25 puan)
      const base = (0.22 + (14 - Math.min(14, sta)) * 0.018) * lateFactor * pressMul * chaseMul * posMul;
      pl.condition = Math.max(28, (Number(pl.condition) || 90) - base);
      condSum += pl.condition;
      n++;
    });
    if (match.depthStats && match.depthStats[side] && n) {
      match.depthStats[side].avgCondition = Math.round(condSum / n);
    }
  }
}

/** Skor farkına göre takım morali (0–100) */
function recomputeMorale(match) {
  if (!match || !match.score) return { home: 50, away: 50 };
  const hs = Number(match.score.home) || 0;
  const as = Number(match.score.away) || 0;
  const minute = Number(match.minute) || 0;
  // Fark etkisi + zaman baskısı
  function sideMorale(my, opp) {
    let m = 50 + (my - opp) * 8;
    if (my - opp >= 2) m += 4;
    if (opp - my >= 2) m -= 5;
    // Geç dakikada geride → moral düşer
    if (minute >= 75 && my < opp) m -= 6;
    if (minute >= 75 && my > opp) m += 3;
    // Erken gol moral boost (gol atan taraf recompute sonrası ayrı güncellenir)
    return Math.max(15, Math.min(90, m));
  }
  match.morale = {
    home: sideMorale(hs, as),
    away: sideMorale(as, hs),
  };
  return match.morale;
}

/** 0.85–1.12 arası moral çarpanı (şut / top tutma) */
function moraleMultiplier(match, side) {
  const m =
    (match && match.morale && match.morale[side] != null
      ? match.morale[side]
      : 50) / 50;
  // 0.5 → 0.85, 1.0 → 1.0, 1.6 → 1.12
  return Math.max(0.85, Math.min(1.14, 0.7 + m * 0.3));
}

/** Ortalama condition çarpanı (0.72–1.05) */
function teamConditionMultiplier(team) {
  const pool = (team && team.players) || [];
  let s = 0;
  let n = 0;
  for (const p of pool) {
    if (!p || p.sentOff) continue;
    s += Number(p.condition) || 70;
    n++;
  }
  if (!n) return 1;
  const avgC = s / n;
  return Math.max(0.72, Math.min(1.05, 0.55 + (avgC / 100) * 0.5));
}

/**
 * Set-piece şansı / çözümü.
 * @returns {object|null} event özeti
 */
function maybeSetPiece(match) {
  if (!match || match.status !== "live" || match.inMajorAction) return null;
  const minute = Number(match.minute) || 0;
  // ~90 dk'da ~4–7 set-piece olayı (korner ağırlıklı)
  if (Math.random() > 0.07) return null;

  const side = match.possessionSide || (Math.random() < 0.5 ? "home" : "away");
  const other = side === "home" ? "away" : "home";
  const attack = match.players[side] && match.players[side].team;
  const defend = match.players[other] && match.players[other].team;
  if (!attack || !defend) return null;

  const r = Math.random();
  // 70% korner, 25% serbest, 5% penaltı
  let kind = "corner";
  if (r > 0.95) kind = "penalty";
  else if (r > 0.7) kind = "freekick";

  // Penaltı çok geç veya çok erken nadiren
  if (kind === "penalty" && (minute < 10 || Math.random() < 0.4)) {
    kind = "freekick";
  }

  match.inMajorAction = true;
  try {
    if (kind === "corner") return resolveCorner(match, side, attack, defend);
    if (kind === "freekick") return resolveFreeKick(match, side, attack, defend);
    return resolvePenalty(match, side, attack, defend);
  } finally {
    match.inMajorAction = false;
  }
}

function pickSetPieceTaker(team, prefer) {
  const pool = (team.players || []).filter(
    (p) => p && !p.sentOff && !p.injured && !isGkPos(p.pos),
  );
  if (!pool.length) return null;
  const weight = (p) => {
    let w = 1;
    const fam = posFamily(p.pos);
    const tech = Number(p.technique) || 10;
    const fin = Number(p.finishing) || 10;
    const vis = Number(p.vision) || 10;
    if (prefer === "shot") {
      w = (fin * 0.55 + tech * 0.35 + vis * 0.1) * (isFwdPos(p.pos) ? 1.4 : 1);
    } else if (prefer === "delivery") {
      w = (tech * 0.4 + vis * 0.35 + (Number(p.passing) || 10) * 0.25) * (fam === "mid" ? 1.35 : 1);
    } else {
      w = tech + fin * 0.5;
    }
    const cond = Math.max(0.5, (Number(p.condition) || 90) / 100);
    return w * cond;
  };
  const total = pool.reduce((s, p) => s + weight(p), 0);
  let x = Math.random() * total;
  for (const p of pool) {
    x -= weight(p);
    if (x <= 0) return p;
  }
  return pool[0];
}

function resolveCorner(match, side, attack, defend) {
  const lang = match.lang || "en";
  if (match.depthStats && match.depthStats[side]) {
    match.depthStats[side].corners = (match.depthStats[side].corners || 0) + 1;
  }
  match.stats[side].corners = (match.stats[side].corners || 0) + 1;

  const taker = pickSetPieceTaker(attack, "delivery");
  const target =
    pickSetPieceTaker(attack, "shot") || findStriker(attack) || taker;
  const gk = findGoalkeeper(defend) || { name: "GK", reflex: 12, handling: 12 };

  match.addLog &&
    match.addLog(
      mt("corner", lang, {
        min: match.minute,
        team: attack.name || match.players[side].username,
        name: (taker && taker.name) || "?",
      }),
    );

  // Korner gol şansı düşük ~%3–6
  const deliv = taker
    ? ((Number(taker.technique) || 10) + (Number(taker.vision) || 10)) / 40
    : 0.4;
  const hdr =
    target != null
      ? ((Number(target.strength) || 10) +
          (Number(target.positioning) || 10) +
          (Number(target.finishing) || 10)) /
        60
      : 0.35;
  const defClear =
    avg(
      (defend.players || [])
        .filter((p) => p && posFamily(p.pos) === "def" && !p.sentOff)
        .map((p) => Number(p.positioning) || 10),
    ) / 20;
  let goalP = 0.025 + deliv * 0.03 + hdr * 0.04 - defClear * 0.025;
  goalP *= moraleMultiplier(match, side);
  goalP = Math.max(0.01, Math.min(0.09, goalP));

  if (Math.random() < goalP && target) {
    return registerSetPieceGoal(match, side, target, "corner_goal", taker);
  }

  // %40 korner sonrası şut fırsatı (isabetsiz/kurtarış)
  if (Math.random() < 0.4 && target) {
    match.stats[side].shots = (match.stats[side].shots || 0) + 1;
    if (Math.random() < 0.35) {
      match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;
      match.addLog &&
        match.addLog(
          mt("save", lang, { gk: gk.name || "GK", name: target.name }),
        );
    } else {
      match.addLog &&
        match.addLog(mt("shot_wide", lang, { name: target.name }));
    }
  } else {
    match.addLog &&
      match.addLog(
        mt("corner_cleared", lang, {
          team: defend.name || match.players[side === "home" ? "away" : "home"].username,
        }),
      );
  }
  // Savunma topla çıkar
  match.possessionSide = side === "home" ? "away" : "home";
  return { kind: "corner", side, scored: false };
}

function resolveFreeKick(match, side, attack, defend) {
  const lang = match.lang || "en";
  if (match.depthStats && match.depthStats[side]) {
    match.depthStats[side].freeKicks =
      (match.depthStats[side].freeKicks || 0) + 1;
  }
  match.stats[side].freeKicks = (match.stats[side].freeKicks || 0) + 1;

  const taker = pickSetPieceTaker(attack, "shot");
  const gk = findGoalkeeper(defend) || { name: "GK", reflex: 12 };

  match.addLog &&
    match.addLog(
      mt("freekick", lang, {
        min: match.minute,
        name: (taker && taker.name) || "?",
      }),
    );

  if (!taker) return { kind: "freekick", side, scored: false };

  match.stats[side].shots = (match.stats[side].shots || 0) + 1;
  const tech = Number(taker.technique) || 10;
  const fin = Number(taker.finishing) || 10;
  const cond = Math.max(0.5, (Number(taker.condition) || 90) / 100);
  let onTargetP = 0.28 + ((tech + fin) / 40) * 0.25;
  onTargetP *= moraleMultiplier(match, side) * cond;
  onTargetP = Math.max(0.18, Math.min(0.55, onTargetP));

  if (Math.random() > onTargetP) {
    match.addLog &&
      match.addLog(mt("shot_wide", lang, { name: taker.name }));
    match.possessionSide = side === "home" ? "away" : "home";
    return { kind: "freekick", side, scored: false };
  }

  match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;
  const save =
    ((Number(gk.reflex) || 12) + (Number(gk.handling) || 12)) / 40;
  let goalP = 0.12 + ((tech + fin) / 40) * 0.18 - save * 0.2;
  goalP *= moraleMultiplier(match, side);
  goalP = Math.max(0.05, Math.min(0.28, goalP));

  if (Math.random() < goalP) {
    return registerSetPieceGoal(match, side, taker, "freekick_goal", null);
  }
  match.addLog &&
    match.addLog(mt("save", lang, { gk: gk.name || "GK", name: taker.name }));
  match.possessionSide = side === "home" ? "away" : "home";
  return { kind: "freekick", side, scored: false };
}

function resolvePenalty(match, side, attack, defend) {
  const lang = match.lang || "en";
  if (match.depthStats && match.depthStats[side]) {
    match.depthStats[side].penalties =
      (match.depthStats[side].penalties || 0) + 1;
  }
  match.stats[side].penalties = (match.stats[side].penalties || 0) + 1;

  const taker =
    pickSetPieceTaker(attack, "shot") || findStriker(attack) || {
      name: "Penaltı",
      finishing: 12,
    };
  const gk = findGoalkeeper(defend) || { name: "GK", reflex: 12 };

  match.addLog &&
    match.addLog(
      mt("penalty", lang, {
        min: match.minute,
        name: taker.name,
      }),
    );

  match.stats[side].shots = (match.stats[side].shots || 0) + 1;
  match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;

  const fin = Number(taker.finishing) || 12;
  const tech = Number(taker.technique) || 11;
  const cond = Math.max(0.55, (Number(taker.condition) || 90) / 100);
  const gkStr =
    ((Number(gk.reflex) || 12) + (Number(gk.positioning) || 11)) / 40;
  // Gerçekçi penaltı gol oranı ~%72–78
  let goalP = 0.62 + (fin + tech) / 80 * 0.2 - gkStr * 0.12;
  goalP *= 0.92 + cond * 0.08;
  goalP *= moraleMultiplier(match, side);
  goalP = Math.max(0.55, Math.min(0.85, goalP));

  if (Math.random() < goalP) {
    return registerSetPieceGoal(match, side, taker, "pen_goal", null);
  }
  match.addLog &&
    match.addLog(
      mt("penalty_miss", lang, {
        name: taker.name,
        gk: gk.name || "GK",
      }),
    );
  match.possessionSide = side === "home" ? "away" : "home";
  return { kind: "penalty", side, scored: false };
}

function registerSetPieceGoal(match, side, scorer, logKey, assister) {
  const other = side === "home" ? "away" : "home";
  match.score[side] = (match.score[side] || 0) + 1;
  match.stats[side].goals = (match.stats[side].goals || 0) + 1;
  if (scorer) scorer.goals = (scorer.goals || 0) + 1;
  if (assister) assister.assists = (assister.assists || 0) + 1;

  match.scorers.push({
    side,
    name: scorer.name,
    minute: match.minute,
    assist: assister ? assister.name : null,
    setPiece: logKey,
  });

  const lang = match.lang || "en";
  match.addLog &&
    match.addLog(
      mt(logKey, lang, {
        min: match.minute,
        name: scorer.name,
        hs: match.score.home,
        as: match.score.away,
      }),
    );

  // Gol sonrası moral
  recomputeMorale(match);
  if (match.morale) {
    match.morale[side] = Math.min(92, (match.morale[side] || 50) + 6);
    match.morale[other] = Math.max(18, (match.morale[other] || 50) - 5);
  }

  match.broadcast &&
    match.broadcast("match:goal", {
      side,
      scorer: scorer.name,
      assist: assister ? assister.name : null,
      minute: match.minute,
      score: { home: match.score.home, away: match.score.away },
      setPiece: logKey,
    });

  // Orta sahadan yeniden başla
  match.possessionSide = other;
  if (match.ball) {
    match.ball.x = 300;
    match.ball.y = 200;
    match.ball.holderSide = other;
  }
  return { kind: logKey, side, scored: true, scorer: scorer.name };
}

/**
 * Kart risk çarpanı: yüksek pres + geride + yorgun defans
 * baseline checkCardEvents içinde random eşiği ile çarpılır
 */
function cardRiskMultiplier(match) {
  if (!match) return 1;
  let mul = 1;
  for (const side of ["home", "away"]) {
    const team = match.players[side] && match.players[side].team;
    if (!team) continue;
    let press = "orta";
    try {
      press = normalizePressIntensity(team.pressIntensity, "orta");
    } catch (_) {}
    if (press === "yüksek") mul += 0.12;
    const other = side === "home" ? "away" : "home";
    if ((match.score[side] || 0) < (match.score[other] || 0)) mul += 0.08;
  }
  const min = Number(match.minute) || 0;
  if (min >= 70) mul += 0.1;
  return Math.min(1.6, mul);
}

/** Sakatlık risk çarpanı: yorgunluk + yüksek pres */
function injuryRiskMultiplier(match) {
  if (!match) return 1;
  let mul = 1;
  for (const side of ["home", "away"]) {
    const avgC =
      (match.depthStats &&
        match.depthStats[side] &&
        match.depthStats[side].avgCondition) ||
      85;
    if (avgC < 55) mul += 0.35;
    else if (avgC < 65) mul += 0.2;
    else if (avgC < 75) mul += 0.1;
    const team = match.players[side] && match.players[side].team;
    if (team) {
      let press = "orta";
      try {
        press = normalizePressIntensity(team.pressIntensity, "orta");
      } catch (_) {}
      if (press === "yüksek") mul += 0.15;
    }
  }
  const min = Number(match.minute) || 0;
  if (min >= 75) mul += 0.15;
  return Math.min(2.0, mul);
}

/** Gol sonrası çağrılmak üzere (shotSystem de kullanabilir) */
function onGoalScored(match, side) {
  recomputeMorale(match);
  if (!match.morale) return;
  const other = side === "home" ? "away" : "home";
  match.morale[side] = Math.min(92, (match.morale[side] || 50) + 5);
  match.morale[other] = Math.max(18, (match.morale[other] || 50) - 4);
}

module.exports = {
  initMatchDepth,
  applyFatigueTick,
  recomputeMorale,
  moraleMultiplier,
  teamConditionMultiplier,
  maybeSetPiece,
  cardRiskMultiplier,
  injuryRiskMultiplier,
  onGoalScored,
};
