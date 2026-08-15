// ============================================================
// cardSystem.js — Maç içi kart (pres + skor + yorgunluk duyarlı)
// ============================================================

function checkCardEvents(match) {
  // ~0.35 kart / maç baseline; yüksek pres / geç dakika artırır
  let threshold = 0.0035;
  try {
    const { cardRiskMultiplier } = require("./matchDepth");
    threshold *= cardRiskMultiplier(match) || 1;
  } catch (_) {}
  if (Math.random() > threshold) return null;

  // Geride olan taraf biraz daha faul yapar
  let side = Math.random() < 0.5 ? "home" : "away";
  try {
    const hs = match.score.home || 0;
    const as = match.score.away || 0;
    if (hs !== as && Math.random() < 0.55) {
      side = hs < as ? "home" : "away";
    }
  } catch (_) {}

  const team = match.players[side].team;
  const pool = (team.players || []).filter((x) => x && !x.sentOff && !x.injured);
  if (!pool.length) return null;

  // Müdahale skoru + düşük condition → risk
  const weight = (p) => {
    let w = 1 + (Number(p.tackle) || 8) * 0.08;
    const c = Number(p.condition) || 90;
    if (c < 60) w *= 1.35;
    else if (c < 75) w *= 1.15;
    const pos = String(p.pos || "").toUpperCase();
    if (/^D|DM/.test(pos)) w *= 1.2;
    return w;
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

  const { mt } = require("./matchI18n");
  const lang = (match && match.lang) || "en";
  const red = Math.random() < 0.05; // doğrudan kırmızı seyrek
  if (red || (p.cards || 0) >= 1) {
    const wasSecond = (p.cards || 0) >= 1;
    p.cards = 2;
    p.sentOff = true;
    // Ceza: ikinci sarı 1 maç, doğrudan kırmızı 2 maç
    p.matchBan = Math.max(Number(p.matchBan) || 0, wasSecond ? 1 : 2);
    match.addLog &&
      match.addLog(
        mt(wasSecond ? "second_yellow" : "red", lang, { name: p.name }),
      );
    try {
      const { syncBallToValidHolder } = require("./ballSystem");
      syncBallToValidHolder(match);
      const { invalidateTeamCombat } = require("./ballSystem");
      invalidateTeamCombat(team);
    } catch (_) {}
  } else {
    p.cards = (p.cards || 0) + 1;
    match.addLog && match.addLog(mt("yellow", lang, { name: p.name }));
  }
  return { side, player: p.name, red: !!p.sentOff };
}

module.exports = { checkCardEvents };
