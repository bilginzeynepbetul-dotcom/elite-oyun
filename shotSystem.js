// ============================================================
// shotSystem.js — Basit otoriter şut / gol motoru
// ============================================================

const { isGkPos, findStriker, findGoalkeeper, skillOf } = require("./teamUtils");
const { mt } = require("./matchI18n");

function pickShooter(match, side) {
  const team = match.players[side] && match.players[side].team;
  if (!team) return null;
  const idx = match.possessionIndex;
  const players = team.players || [];
  let p = players[idx];
  if (!p || isGkPos(p.pos) || p.sentOff || p.injured) {
    p = findStriker(team);
  }
  if (!p || p.sentOff || p.injured) {
    p = players.find((x) => x && !isGkPos(x.pos) && !x.sentOff && !x.injured);
  }
  return p || null;
}

function gkOf(match, defendingSide) {
  const team = match.players[defendingSide] && match.players[defendingSide].team;
  return findGoalkeeper(team);
}

/**
 * @returns {{ scored: boolean, text: string, shooter?: object } | null}
 */
function attemptShot(match, side) {
  const shooter = pickShooter(match, side);
  if (!shooter) return null;

  const defending = side === "home" ? "away" : "home";
  const gk = gkOf(match, defending);

  const finishing =
    skillOf(shooter, "finishing") * 0.55 +
    skillOf(shooter, "technique") * 0.25 +
    skillOf(shooter, "pace") * 0.1 +
    (Number(shooter.form) || 0) * 0.4 +
    (Number(shooter.condition) || 80) * 0.02;

  const gkSkill = gk
    ? skillOf(gk, "reflex") * 0.55 +
      skillOf(gk, "handling") * 0.25 +
      skillOf(gk, "positioning") * 0.2
    : 10;

  // Moral / form çarpanı
  let moraleMod = 1;
  try {
    if (match.morale && match.morale[side] != null) {
      moraleMod = 0.85 + (Number(match.morale[side]) / 100) * 0.3;
    }
  } catch (_) {}

  const attackBonus =
    (match.players[side].team &&
      match.players[side].team.matchBonuses &&
      match.players[side].team.matchBonuses.attack) ||
    0;

  const chance = Math.max(
    0.08,
    Math.min(
      0.72,
      ((finishing + attackBonus * 0.5) / (finishing + gkSkill + 8)) * moraleMod,
    ),
  );

  match.stats[side].shots = (match.stats[side].shots || 0) + 1;

  const onTarget = Math.random() < chance + 0.25;
  if (onTarget) {
    match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;
  }

  const scored = onTarget && Math.random() < chance;
  const name = shooter.name || "Oyuncu";
  const lang = match.lang || "tr";

  if (scored) {
    match.score[side] = (match.score[side] || 0) + 1;
    match.stats[side].goals = (match.stats[side].goals || 0) + 1;
    shooter.goals = (shooter.goals || 0) + 1;
    match.scorers = match.scorers || [];
    match.scorers.push({
      side,
      name,
      minute: match.minute,
      playerId: shooter.id || null,
    });
    // mt(key, lang, vars) — önceden (lang, key, vars) sırasıyla çağrılıyordu,
    // bu yüzden "goal" satır anahtarı yerine dil kodu ("tr"/"en"...) döndürülüp
    // maç logunda gol/kurtarış/kaçırma anları anlamsız kısa kodlar olarak
    // görünüyordu. Sıra ve değişken adları (scorer/min/hs/as) düzeltildi.
    const text =
      typeof mt === "function"
        ? mt("goal", lang, {
            scorer: name,
            assist: "",
            min: match.minute,
            hs: match.score.home,
            as: match.score.away,
          }) || `⚽ GOL! ${name} (${match.minute}')`
        : `⚽ GOL! ${name} (${match.minute}')`;
    match.addLog && match.addLog(text);
    match.broadcast &&
      match.broadcast("match:goal", {
        side,
        scorer: name,
        minute: match.minute,
        score: { ...match.score },
      });
    return { scored: true, text, shooter };
  }

  if (onTarget && gk) {
    gk.saves = (gk.saves || 0) + 1;
    const text =
      typeof mt === "function"
        ? mt("save", lang, { gk: gk.name, name }) ||
          `🧤 ${gk.name} kurtardı (${name})`
        : `🧤 ${(gk && gk.name) || "Kaleci"} kurtardı (${name})`;
    match.addLog && match.addLog(text);
    return { scored: false, text, shooter };
  }

  const text =
    typeof mt === "function"
      ? mt("shot_wide", lang, { name }) || `🎯 ${name} şut — isabetsiz`
      : `🎯 ${name} şut — isabetsiz`;
  match.addLog && match.addLog(text);
  return { scored: false, text, shooter };
}

module.exports = { attemptShot };
