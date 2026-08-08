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
} = require("./teamUtils");

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

/** index-30.html'deki calculateTurnoverProbability() portu */
function turnoverProbability(match, possSide) {
  const team = possSide === "home" ? match.players.home.team : match.players.away.team;
  const opp = possSide === "home" ? match.players.away.team : match.players.home.team;
  const teamOutfield = team.players.filter((p) => p.pos !== "GK");
  const oppOutfield = opp.players.filter((p) => p.pos !== "GK");

  const controlScore =
    avg(teamOutfield, "passing") * 0.35 +
    avg(teamOutfield, "technique") * 0.35 +
    avg(teamOutfield, "agility") * 0.3 +
    ((team.matchBonuses || {}).midfield || 0) * 1.4;

  const oppSide = possSide === "home" ? "away" : "home";
  const pressScore =
    avg(oppOutfield, "tackle") * 0.45 +
    avg(oppOutfield, "strength") * 0.3 +
    avg(oppOutfield, "stamina") * 0.25 +
    ((opp.matchBonuses || {}).defense || 0) * 1.4 +
    ((opp.matchBonuses || {}).midfield || 0) * 0.8;

  let prob = 0.1 + (pressScore - controlScore) * 0.0045;
  if (team.gameStyle === "hücumsel") prob += 0.025;
  else if (team.gameStyle === "defansif") prob -= 0.025;

  const myP = teamStrength(team);
  const opP = teamStrength(opp);
  const gap = (opP - myP) / 100; // zayıfken top kaybı artar
  prob += gap * 0.14;

  return Math.max(0.035, Math.min(0.48, prob));
}

/** index-30.html'deki pickWeightedByTackle() portu — top kazanan defansif oyuncu */
function pickWeightedByTackle(team) {
  const outfield = team.players.filter((p) => p.pos !== "GK");
  if (!outfield.length) return null;
  const totalWeight = outfield.reduce((s, p) => s + (Number(p.tackle) || 10), 0);
  let r = Math.random() * totalWeight;
  for (const p of outfield) {
    r -= Number(p.tackle) || 10;
    if (r <= 0) return p;
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
function longPassChance(style) {
  switch (style) {
    case "uzun":
      return 0.55;
    case "hizli":
    case "hızlı":
      return 0.25;
    case "karisik":
    case "karışık":
      return Math.random() < 0.5 ? 0.15 : 0.55;
    case "kisa":
    case "kısa":
    default:
      return 0.15;
  }
}

/** index-30.html'deki pickNextTeammate() portu — pas alacak bir sonraki oyuncu */
function pickNextTeammate(team, currentIndex) {
  const famRank = { GK: -1, DF: 0, DM: 1, MF: 2, AM: 3, FW: 4 };
  const attackDir = team.attackDir || "orta";
  const order = team.players
    .map((p, i) => ({ p, i }))
    .filter((o) => !isGkPos(o.p.pos) && !o.p.sentOff)
    .sort((a, b) => (famRank[posFamily(a.p.pos)] ?? 2) - (famRank[posFamily(b.p.pos)] ?? 2));

  if (order.length === 0) return currentIndex;
  const currentRankPos = order.findIndex((o) => o.i === currentIndex);
  const safeRankPos = currentRankPos >= 0 ? currentRankPos : 0;

  const chance = longPassChance(team.passStyle);

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
      event = { type: "turnover", text: `${winningTeam.name} topu kazandı.` };
    }
  }

  const team =
    match.possessionSide === "home" ? match.players.home.team : match.players.away.team;
  const fromIndex = Math.min(match.possessionIndex, team.players.length - 1);
  const nextIndex = pickNextTeammate(team, fromIndex);
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
  pickWeightedByTackle,
  possessionPercent,
  syncBallToValidHolder,
};
