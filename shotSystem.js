// ============================================================
// shotSystem.js — Beceri tabanlı şut / gol motoru
// ------------------------------------------------------------
// Eski stub yerine: forvet bitiricilik, kaleci refleks/handling,
// defans tackle, formasyon, oyun stili, yorgunluk, skor farkı.
// matchEngine.attemptShot(match, side) imzası aynı kalır.
// ============================================================

const {
  posFamily,
  isGkPos,
  isFwdPos,
  findStriker,
  findGoalkeeper,
  avg,
  teamStrength,
} = require("./teamUtils");

/** Ağırlıklı şutçu seçimi — forvet > AM > kanat > orta saha */
function pickShooter(team) {
  const pool = (team.players || []).filter(
    (p) => p && !p.sentOff && !p.injured && !isGkPos(p.pos),
  );
  if (!pool.length) return team.players && team.players[0];

  const attackDir = team.attackDir || "orta";
  const weight = (p) => {
    const fam = posFamily(p.pos);
    const pos = String(p.pos || "").toUpperCase();
    let w = 1;
    if (fam === "FW") w = 6;
    else if (fam === "AM") w = 4;
    else if (fam === "MF") w = 2;
    else if (fam === "DM") w = 1.2;
    else w = 0.8; // DF — ara sıra şut
    // Hücum yönü: kanatlardan / sol / sağ → kanat oyuncularına ağırlık
    const isLeftWing = pos === "FL" || pos === "ML" || pos === "DL" || pos === "AML";
    const isRightWing = pos === "FR" || pos === "MR" || pos === "DR" || pos === "AMR";
    const isWing = isLeftWing || isRightWing || pos === "WL" || pos === "WR";
    if (attackDir === "kanatlardan" && isWing) w *= 1.85;
    else if (attackDir === "sol" && isLeftWing) w *= 2.1;
    else if (attackDir === "sag" && isRightWing) w *= 2.1;
    else if (attackDir === "orta" && (fam === "FW" || fam === "AM") && !isWing) w *= 1.25;
    const fin = Number(p.finishing) || 10;
    const tech = Number(p.technique) || 10;
    const form = 1 + (Number(p.form) || 0) * 0.03;
    const cond = Math.max(0.5, (Number(p.condition) || 90) / 100);
    return w * (fin * 0.6 + tech * 0.4) * form * cond;
  };

  const total = pool.reduce((s, p) => s + weight(p), 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= weight(p);
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

/** Asist adayı — şutçu hariç, pas/vizyon yüksek oyuncu */
function pickAssister(team, shooter) {
  if (Math.random() > 0.62) return null; // ~%38 şutlar asistsiz
  const pool = (team.players || []).filter(
    (p) =>
      p &&
      !p.sentOff &&
      !p.injured &&
      p !== shooter &&
      !isGkPos(p.pos),
  );
  if (!pool.length) return null;
  const weight = (p) => {
    const fam = posFamily(p.pos);
    let w = fam === "AM" || fam === "MF" ? 3 : fam === "FW" ? 1.5 : 1;
    return w * ((Number(p.passing) || 10) + (Number(p.vision) || 10));
  };
  const total = pool.reduce((s, p) => s + weight(p), 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= weight(p);
    if (r <= 0) return p;
  }
  return pool[0];
}

/**
 * Şut kalitesini 0–1 aralığında üretir.
 * Yüksek = isabet + gol ihtimali artar.
 */
function shotQuality(shooter, attackTeam, defendTeam) {
  const fin = Number(shooter.finishing) || 10;
  const tech = Number(shooter.technique) || 10;
  const pos = Number(shooter.positioning) || 10;
  const pace = Number(shooter.pace) || 10;
  const cond = Math.max(0.45, (Number(shooter.condition) || 90) / 100);

  // Şutçu bireysel (~0–20 ölçeği → normalize)
  let q = (fin * 0.45 + tech * 0.25 + pos * 0.2 + pace * 0.1) / 20;

  // Hücum takım desteği
  const atkBonus = (attackTeam.matchBonuses || {}).attack || 0;
  q += atkBonus * 0.015;

  if (attackTeam.gameStyle === "hücumsel") q += 0.04;
  else if (attackTeam.gameStyle === "defansif") q -= 0.03;

  // Takım gücü farkı
  const gap = (teamStrength(attackTeam) - teamStrength(defendTeam)) / 100;
  q += gap * 0.12;

  // Yorgunluk (dakika matchEngine'den gelmiyor; condition zaten proxy)
  q *= 0.85 + cond * 0.15;

  return Math.max(0.08, Math.min(0.92, q));
}

/**
 * Kaleci + defans kurtarış gücü (0–1).
 */
function saveStrength(gk, defendTeam) {
  const reflex = Number(gk.reflex) || 10;
  const handling = Number(gk.handling) || 10;
  const positioning = Number(gk.positioning) || 10;
  const cond = Math.max(0.5, (Number(gk.condition) || 90) / 100);

  let s = (reflex * 0.45 + handling * 0.35 + positioning * 0.2) / 20;
  s *= 0.85 + cond * 0.15;

  const defs = (defendTeam.players || []).filter(
    (p) => isGkPos(p.pos) === false && !p.sentOff && posFamily(p.pos) === "DF",
  );
  const defAvg =
    avg(defs, "tackle", 10) * 0.5 + avg(defs, "positioning", 10) * 0.5;
  s += (defAvg / 20) * 0.18;

  const defBonus = (defendTeam.matchBonuses || {}).defense || 0;
  s += defBonus * 0.012;

  if (defendTeam.gameStyle === "defansif") s += 0.04;
  else if (defendTeam.gameStyle === "hücumsel") s -= 0.025;

  return Math.max(0.12, Math.min(0.88, s));
}

/**
 * Ana giriş: matchEngine.tick → attemptShot(match, side)
 * @returns {{ scored: boolean, scorer?: string, assist?: string, onTarget?: boolean }}
 */
function attemptShot(match, side) {
  const other = side === "home" ? "away" : "home";
  const attack = match.players[side].team;
  const defend = match.players[other].team;

  match.stats[side].shots = (match.stats[side].shots || 0) + 1;

  const shooter = pickShooter(attack) || findStriker(attack) || { name: "Oyuncu" };
  const gk = findGoalkeeper(defend) || { name: "Kaleci", reflex: 10, handling: 10 };
  const quality = shotQuality(shooter, attack, defend);
  const save = saveStrength(gk, defend);

  // İsabet: şut kalitesi baskın, biraz rastgelelik
  const onTargetChance = Math.max(0.18, Math.min(0.78, 0.22 + quality * 0.55));
  const onTarget = Math.random() < onTargetChance;

  if (!onTarget) {
    const missLog =
      Math.random() < 0.45
        ? "Şut auta gitti (" + shooter.name + ")"
        : Math.random() < 0.5
          ? "Şut bloklandı (" + shooter.name + ")"
          : "Şut direğin yanından (" + shooter.name + ")";
    match.addLog && match.addLog(missLog);
    return { scored: false, onTarget: false, scorer: shooter.name };
  }

  match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;

  // Gol şansı: quality vs save; tipik maçta ~0.25–0.40 on-target conversion
  let goalChance = 0.12 + (quality - save) * 0.55;
  goalChance = Math.max(0.06, Math.min(0.52, goalChance));

  // Skor farkı: önde olan biraz daha az, geride olan biraz daha istekli
  const diff = (match.score[side] || 0) - (match.score[other] || 0);
  if (diff <= -2) goalChance += 0.03;
  else if (diff >= 2) goalChance -= 0.025;

  const scored = Math.random() < goalChance;

  if (scored) {
    match.score[side] = (match.score[side] || 0) + 1;
    match.stats[side].goals = (match.stats[side].goals || 0) + 1;

    shooter.goals = (shooter.goals || 0) + 1;
    const assister = pickAssister(attack, shooter);
    if (assister) assister.assists = (assister.assists || 0) + 1;

    const entry = {
      side,
      name: shooter.name,
      minute: match.minute,
      assist: assister ? assister.name : null,
    };
    match.scorers.push(entry);

    const assistText = assister ? " (Asist: " + assister.name + ")" : "";
    match.addLog &&
      match.addLog(
        "⚽ GOL! " +
          shooter.name +
          assistText +
          " (" +
          match.minute +
          "') — " +
          match.score.home +
          "-" +
          match.score.away,
      );

    match.broadcast &&
      match.broadcast("match:goal", {
        side,
        scorer: shooter.name,
        assist: assister ? assister.name : null,
        minute: match.minute,
        score: { home: match.score.home, away: match.score.away },
      });

    return {
      scored: true,
      onTarget: true,
      scorer: shooter.name,
      assist: assister ? assister.name : null,
    };
  }

  // İsabetli ama gol değil
  const saveLog =
    Math.random() < 0.55
      ? "Kurtarış! " + (gk.name || "Kaleci") + " (" + shooter.name + " şutu)"
      : "Şut kalecide (" + shooter.name + ")";
  if (gk.saves != null) gk.saves = (gk.saves || 0) + 1;
  match.addLog && match.addLog(saveLog);
  return { scored: false, onTarget: true, scorer: shooter.name };
}

module.exports = { attemptShot, pickShooter, shotQuality, saveStrength };
