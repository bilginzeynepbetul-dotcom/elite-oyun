function checkInjuryEvents(match) {
  // ~0.12 sakatlık / maç
  if (Math.random() > 0.0014) return null;
  const side = Math.random() < 0.5 ? "home" : "away";
  const team = match.players[side].team;
  const pool = (team.players || []).filter((p) => p && !p.injured && !p.sentOff);
  if (!pool.length) return null;
  const weight = (p) => {
    const c = Number(p.condition);
    if (c > 0 && c < 60) return 2.2;
    if (c > 0 && c < 75) return 1.4;
    return 1;
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
  p.injuryDaysLeft = 1 + Math.floor(Math.random() * 3);
  const { mt } = require("./matchI18n");
  const lang = (match && match.lang) || "en";
  match.addLog && match.addLog(mt("injury", lang, { name: p.name }));
  return { side, player: p.name };
}
module.exports = { checkInjuryEvents };
