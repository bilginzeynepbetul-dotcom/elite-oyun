// ============================================================
// ballSystem.js — index-30.html'deki TOP SİRKÜLASYONU mantığının
// sunucu taraflı, otoriter portu.
// ------------------------------------------------------------
// Orijinal karşılıklar (referans için):
//   circulateBall()                -> circulateBall(match)
//   calculateTurnoverProbability() -> turnoverProbability(match, side)
//   pickNextTeammate()             -> pickNextTeammate()
//   pickWeightedByTackle()         -> pickWeightedByTackle()
//
// Orijinalde topun sahadaki x/y'si canvas çizimi için kullanılıyordu.
// Sunucuda çizim yok; x/y yine de tutuluyor çünkü istemci tarafında
// saha animasyonunu ileride bu veriyle besleyeceğiz.
// ============================================================

const {
  posFamily,
  isGkPos,
  avg,
  teamStrength,
  assignFormationPositions,
  teamAvgExperience,
  experienceErrorFactor,
} = require("./teamUtils");
const {
  normalizePressIntensity,
  normalizeTransitionStyle,
  normalizePassStyle,
  normalizeAttackDir,
} = require("./tacticNormalize");
const { mt } = require("./matchI18n");

/** match nesnesine top/possession alanlarını ekler (Match constructor'ından çağrılır) */
function initBallState(match) {
  assignFormationPositions(match.players.home.team, match.players.away.team);
  const kicker = match.players.home.team.players.find((p) => !isGkPos(p.pos));
  match.possessionSide = "home";
  match.possessionIndex = kicker ? match.players.home.team.players.indexOf(kicker) : 0;
  match.inMajorAction = false;
  match.ball = {
    x: 300,
    y: 200,
    targetX: 300,
    targetY: 200,
    holderName: kicker ? kicker.name : null,
    holderSide: "home",
  };
}

/** Takım güç skorlarını cache'ler — her pas dolaşımında yeniden avg/filter yapma */
function getTeamCombatCache(team) {
  if (!team) return { control: 10, press: 10, strength: 50, outfield: [] };
  const gen = team._combatGen || 0;
  if (team._combatCache && team._combatCache.gen === gen) return team._combatCache;
  const outfield = [];
  const players = team.players || [];
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p && p.pos !== "GK" && !p.sentOff) outfield.push(p);
  }
  const control =
    avg(outfield, "passing") * 0.35 +
    avg(outfield, "technique") * 0.35 +
    avg(outfield, "agility") * 0.3 +
    ((team.matchBonuses || {}).midfield || 0) * 1.4;
  const press =
    avg(outfield, "tackle") * 0.45 +
    avg(outfield, "strength") * 0.3 +
    avg(outfield, "stamina") * 0.25 +
    ((team.matchBonuses || {}).defense || 0) * 1.4 +
    ((team.matchBonuses || {}).midfield || 0) * 0.8;
  const cache = {
    gen,
    outfield,
    control,
    press,
    strength: teamStrength(team),
  };
  team._combatCache = cache;
  return cache;
}

/** Stil/kadro değişince cache invalidation */
function invalidateTeamCombat(team) {
  if (team) team._combatGen = (team._combatGen || 0) + 1;
}

/** Pres / skor / dakika yardımcıları */
function _pressFactor(intensity) {
  let p = intensity;
  try {
    p = normalizePressIntensity(intensity, "orta");
  } catch (_) {
    p = String(intensity || "orta").toLowerCase();
  }
  if (p === "yüksek") return 1.22;
  if (p === "düşük") return 0.78;
  return 1.0;
}

/** Skorda önde + son 15 dk → top tutma / zaman kazanma */
function isKeepBallActive(match, possSide) {
  if (!match || !match.score) return false;
  const minute = Number(match.minute) || 0;
  if (minute < 75) return false;
  const my = possSide === "home" ? match.score.home : match.score.away;
  const opp = possSide === "home" ? match.score.away : match.score.home;
  return Number(my) > Number(opp);
}

/** Kontra: berabere veya gerideyken aktif */
function isKontraActive(team, match, side) {
  if (!team) return false;
  let tr = team.transitionStyle;
  try {
    tr = normalizeTransitionStyle(tr, "normal");
  } catch (_) {
    tr = String(tr || "normal").toLowerCase();
  }
  if (tr !== "kontra") return false;
  if (!match || !match.score) return true;
  const my = side === "home" ? match.score.home : match.score.away;
  const opp = side === "home" ? match.score.away : match.score.home;
  return Number(my) <= Number(opp);
}

/** index-30.html'deki calculateTurnoverProbability() portu */
function turnoverProbability(match, possSide) {
  const team = possSide === "home" ? match.players.home.team : match.players.away.team;
  const opp = possSide === "home" ? match.players.away.team : match.players.home.team;
  const my = getTeamCombatCache(team);
  const their = getTeamCombatCache(opp);

  // Rakip pres yoğunluğu (ayrı eksen): yüksek pres top çalma ihtimalini artırır
  const theirPressMul = _pressFactor(opp.pressIntensity);
  const myPressMul = _pressFactor(team.pressIntensity);
  // Yüksek pres kendi takımda da risk: blok düşükken control daha sağlam
  const adjustedPress = their.press * theirPressMul;
  const adjustedControl = my.control * (2.05 - myPressMul); // yuksek→~0.83x, dusuk→~1.27x

  let prob = 0.1 + (adjustedPress - adjustedControl) * 0.0045;
  if (team.gameStyle === "hücumsel") prob += 0.025;
  else if (team.gameStyle === "defansif") prob -= 0.025;

  const gap = (their.strength - my.strength) / 100;
  prob += gap * 0.14;

  // Kontra: topa sahipken biraz daha riskli (hızlı çıkış), ama top kazanmaya teşvik
  if (isKontraActive(team, match, possSide)) {
    prob += 0.012;
  }

  // Zaman kazanma / top tutma: öndeyken 75'+ kısa ve güvenli
  if (isKeepBallActive(match, possSide)) {
    prob -= 0.055;
  }

  // Tecrübe: sahip taraf topu daha az kaybeder; rakip tecrübesi pres kalitesini artırır
  try {
    const myExp = teamAvgExperience(team); // 1–10
    const theirExp = teamAvgExperience(opp);
    // +1 seviye sahip ≈ -0.008 top kaybı; rakip +1 ≈ +0.006
    prob -= (myExp - 5) * 0.008;
    prob += (theirExp - 5) * 0.006;
  } catch (_) {}

  // Yorgunluk + moral (matchDepth)
  try {
    const {
      teamConditionMultiplier,
      moraleMultiplier,
    } = require("./matchDepth");
    const condMul = teamConditionMultiplier(team);
    // Düşük condition → daha fazla top kaybı
    prob += (1 - condMul) * 0.08;
    const mor = moraleMultiplier(match, possSide);
    // Düşük moral → biraz daha fazla hata
    prob += (1 - mor) * 0.05;
  } catch (_) {}

  // Geç dakika genel yorgunluk
  const minute = Number(match.minute) || 0;
  if (minute >= 80) prob += 0.02;
  else if (minute >= 70) prob += 0.01;

  return Math.max(0.035, Math.min(0.48, prob));
}

/** index-30.html'deki pickWeightedByTackle() portu — top kazanan defansif oyuncu */
function pickWeightedByTackle(team) {
  const cache = getTeamCombatCache(team);
  const outfield = cache.outfield;
  if (!outfield.length) return null;
  let totalWeight = 0;
  for (let i = 0; i < outfield.length; i++) {
    totalWeight += Number(outfield[i].tackle) || 10;
  }
  let r = Math.random() * totalWeight;
  for (let i = 0; i < outfield.length; i++) {
    r -= Number(outfield[i].tackle) || 10;
    if (r <= 0) return outfield[i];
  }
  return outfield[outfield.length - 1];
}

/** Takımın pas stiline göre bu adımda "uzun pas" (rastgele takım arkadaşına,
 *  komşu olmayan) verilme ihtimalini döndürür.
 *   kısa    -> genelde komşu oyuncuya kısa pas
 *   hızlı   -> normal tempo, orijinal davranışa yakın
 *   uzun    -> sık sık uzun/sürpriz pas
 *   karışık -> her pasta kısa ya da uzun moddan biri rastgele seçilir,
 *              böylece hem uzun hem kısa paslar karışık şekilde denenir
 */
function longPassChance(style, team, match, side) {
  // Zaman kazanma: zorunlu kısa/güvenli pas
  if (team && match && side && isKeepBallActive(match, side)) {
    return 0.06;
  }
  // Kontra aktifken biraz daha uzun/hızlı çıkış
  let kontra = false;
  if (team && match && side) {
    try {
      kontra = isKontraActive(team, match, side);
    } catch (_) {}
  }
  let s = style;
  try {
    s = normalizePassStyle(style, "kisa");
  } catch (_) {
    s = String(style || "kisa").toLowerCase();
  }
  if (kontra && s === "kisa") s = "hizli";
  switch (s) {
    case "uzun":
      return kontra ? 0.62 : 0.55;
    case "hizli":
      return kontra ? 0.32 : 0.25;
    case "karisik":
      return Math.random() < 0.5 ? 0.15 : 0.55;
    case "kisa":
    default:
      return 0.15;
  }
}

/** index-30.html'deki pickNextTeammate() portu — pas alacak bir sonraki oyuncu */
function pickNextTeammate(team, currentIndex, match, side) {
  const famRank = { GK: -1, DF: 0, DM: 1, MF: 2, AM: 3, FW: 4 };
  let attackDir = team.attackDir || "orta";
  try {
    attackDir = normalizeAttackDir(attackDir, "orta");
  } catch (_) {}
  const order = team.players
    .map((p, i) => ({ p, i }))
    .filter((o) => !isGkPos(o.p.pos) && !o.p.sentOff)
    .sort((a, b) => (famRank[posFamily(a.p.pos)] ?? 2) - (famRank[posFamily(b.p.pos)] ?? 2));

  if (order.length === 0) return currentIndex;
  const currentRankPos = order.findIndex((o) => o.i === currentIndex);
  const safeRankPos = currentRankPos >= 0 ? currentRankPos : 0;

  const chance = longPassChance(team.passStyle, team, match, side);

  const isWingPos = (pos) => {
    const p = String(pos || "").toUpperCase();
    return (
      p === "FL" || p === "FR" || p === "ML" || p === "MR" ||
      p === "WL" || p === "WR" || p === "AML" || p === "AMR"
    );
  };
  const isLeft = (pos) => {
    const p = String(pos || "").toUpperCase();
    return p === "FL" || p === "ML" || p === "DL" || p === "WL" || p === "AML";
  };
  const isRight = (pos) => {
    const p = String(pos || "").toUpperCase();
    return p === "FR" || p === "MR" || p === "DR" || p === "WR" || p === "AMR";
  };

  // Kanat odaklı hücum: pasları kanatlara yönlendir
  let wingBias = 0;
  if (attackDir === "kanatlardan") wingBias = 0.45;
  else if (attackDir === "sol" || attackDir === "sag") wingBias = 0.4;

  if (wingBias > 0 && Math.random() < wingBias) {
    const wings = order.filter((o) => {
      if (attackDir === "sol") return isLeft(o.p.pos);
      if (attackDir === "sag") return isRight(o.p.pos);
      return isWingPos(o.p.pos);
    });
    if (wings.length) {
      return wings[Math.floor(Math.random() * wings.length)].i;
    }
  }

  let nextEntry;
  if (Math.random() >= chance) {
    const step = Math.random() < 0.5 ? 1 : -1;
    const nextIdx = (((safeRankPos + step) % order.length) + order.length) % order.length;
    nextEntry = order[nextIdx];
  } else {
    nextEntry = order[Math.floor(Math.random() * order.length)];
  }
  return nextEntry.i;
}

/**
 * Bir top sirkülasyonu adımı: ya top el değiştirir (turnover) ya da
 * mevcut takım kendi arasında pas yapar. index-30.html'deki
 * circulateBall() ile birebir aynı akış.
 * @returns {object|null} olay açıklaması (log için) — sessiz paslarda null döner
 */
function circulateBall(match) {
  if (match.status !== "live" || match.inMajorAction) return null;

  let event = null;
  const turnoverChance = turnoverProbability(match, match.possessionSide);

  if (Math.random() < turnoverChance) {
    match.possessionSide = match.possessionSide === "home" ? "away" : "home";
    const winningTeam =
      match.possessionSide === "home" ? match.players.home.team : match.players.away.team;
    const outfieldIdx = winningTeam.players
      .map((p, i) => i)
      .filter((i) => winningTeam.players[i].pos !== "GK");
    match.possessionIndex = outfieldIdx.length
      ? outfieldIdx[Math.floor(Math.random() * outfieldIdx.length)]
      : 0;

    const defender = pickWeightedByTackle(winningTeam);
    if (defender) defender.keyActions = (defender.keyActions || 0) + 1;

    if (Math.random() < 0.35) {
      const lang = (match && match.lang) || "en";
      event = {
        type: "turnover",
        text: mt("turnover", lang, { team: winningTeam.name }),
      };
    }
  }

  const team =
    match.possessionSide === "home" ? match.players.home.team : match.players.away.team;
  const fromIndex = Math.min(match.possessionIndex, team.players.length - 1);
  const nextIndex = pickNextTeammate(
    team,
    fromIndex,
    match,
    match.possessionSide,
  );
  const nextPlayer = team.players[nextIndex];
  match.possessionIndex = nextIndex;

  match.ball.holderName = nextPlayer.name;
  match.ball.holderSide = match.possessionSide;
  if (nextPlayer.x != null && nextPlayer.y != null) {
    match.ball.targetX = nextPlayer.x;
    match.ball.targetY = nextPlayer.y;
    match.ball.x = nextPlayer.x;
    match.ball.y = nextPlayer.y;
  }
  match.stats[match.possessionSide].possessionTicks =
    (match.stats[match.possessionSide].possessionTicks || 0) + 1;

  return event;
}

/** Possession yüzdesini hesaplar (updateStatsDisplay() portu) */
function possessionPercent(match) {
  const h = match.stats.home.possessionTicks || 0;
  const a = match.stats.away.possessionTicks || 0;
  const total = h + a;
  const homePct = total > 0 ? Math.round((h / total) * 100) : 50;
  return { home: homePct, away: 100 - homePct };
}

/** Sakatlık/değişiklik sonrası topun elindeki oyuncu artık sahada değilse
 *  (yedeğe düşmüşse), topu güvenli, gerçekten sahada olan bir oyuncuya bağlar.
 *  index-30.html'deki syncBallToValidHolder() portu. */
function syncBallToValidHolder(match) {
  const homePlayers = match.players.home.team.players;
  const awayPlayers = match.players.away.team.players;
  const stillValid =
    match.ball.holderName &&
    (homePlayers.some((p) => p.name === match.ball.holderName) ||
      awayPlayers.some((p) => p.name === match.ball.holderName));
  if (stillValid) return;

  const team =
    match.possessionSide === "home" ? match.players.home.team : match.players.away.team;
  const fallback = team.players.find((p) => p.pos !== "GK" && !p.sentOff) || team.players[0];
  if (!fallback) return;
  match.possessionIndex = team.players.indexOf(fallback);
  match.ball.holderName = fallback.name;
  match.ball.holderSide = match.possessionSide;
  if (fallback.x != null && fallback.y != null) {
    match.ball.targetX = fallback.x;
    match.ball.targetY = fallback.y;
    match.ball.x = fallback.x;
    match.ball.y = fallback.y;
  }
}

module.exports = {
  initBallState,
  circulateBall,
  turnoverProbability,
  pickNextTeammate,
  isKeepBallActive,
  isKontraActive,
  pickWeightedByTackle,
  possessionPercent,
  syncBallToValidHolder,
  invalidateTeamCombat,
  getTeamCombatCache,
};
