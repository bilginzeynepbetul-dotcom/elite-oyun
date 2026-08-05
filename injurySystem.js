function checkInjuryEvents(match) {
  if (Math.random() > 0.01) return null;
  const side = Math.random() < 0.5 ? "home" : "away";
  const team = match.players[side].team;
  const pool = (team.players || []).filter((p) => !p.injured && !p.sentOff);
  if (!pool.length) return null;
  const p = pool[Math.floor(Math.random() * pool.length)];
  p.injured = true;
  match.addLog && match.addLog("Sakatlık: " + p.name);
  return { side, player: p.name };
}
module.exports = { checkInjuryEvents };
