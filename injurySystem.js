// ============================================================
// injurySystem.js — Maç içi sakatlık (yorgunluk + pres duyarlı)
// ============================================================

function checkInjuryEvents(match) {
  // Baseline ~0.12 sakatlık / maç; yorgunluk/pres ile artar
  let threshold = 0.0014;
  try {
    const { injuryRiskMultiplier } = require("./matchDepth");
    threshold *= injuryRiskMultiplier(match) || 1;
  } catch (_) {}
  if (Math.random() > threshold) return null;

  const side = Math.random() < 0.5 ? "home" : "away";
  const team = match.players[side].team;
  const pool = (team.players || []).filter((p) => p && !p.injured && !p.sentOff);
  if (!pool.length) return null;

  const weight = (p) => {
    const c = Number(p.condition);
    let w = 1;
    if (c > 0 && c < 50) w = 3.2;
    else if (c > 0 && c < 60) w = 2.2;
    else if (c > 0 && c < 75) w = 1.4;
    // Yüksek stamina biraz korur
    const sta = Number(p.stamina) || 10;
    w *= 1.25 - Math.min(0.35, sta * 0.02);
    // Forvet / kanat daha fazla sprint → risk
    const pos = String(p.pos || "").toUpperCase();
    if (/^F|W|AM/.test(pos)) w *= 1.15;
    return Math.max(0.3, w);
  };

  const total = pool.reduce((s, p) => s + weight(p), 0);
  let r = Math.random() * total;
  let p = pool[0];
  for (const x of pool) {
    r -= weight(x);
    if (r <= 0) {
      p = x;
      break;
    }
  }

  p.injured = true;
  // Yorgun sakatlık biraz daha uzun sürebilir
  const cond = Number(p.condition) || 70;
  const baseDays = cond < 55 ? 5 : 3;
  p.injuryDaysLeft = baseDays + Math.floor(Math.random() * 5); // 3–9 gün
  p.condition = Math.min(p.condition || 50, 40);

  const { mt } = require("./matchI18n");
  const lang = (match && match.lang) || "en";
  match.addLog && match.addLog(mt("injury", lang, { name: p.name }));

  // Top bu oyuncudaysa devret
  try {
    if (match.ball && match.ball.holderName === p.name) {
      const { syncBallToValidHolder } = require("./ballSystem");
      syncBallToValidHolder(match);
    }
  } catch (_) {}

  return { side, player: p.name, days: p.injuryDaysLeft };
}

module.exports = { checkInjuryEvents };
