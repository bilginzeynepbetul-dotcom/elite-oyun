function checkCardEvents(match) {
  if (Math.random() > 0.01) return null;
  const side = Math.random() < 0.5 ? "home" : "away";
  const team = match.players[side].team;
  const p =
    (team.players && team.players[Math.floor(Math.random() * team.players.length)]) ||
    null;
  if (!p) return null;
  const red = Math.random() < 0.12;
  if (red) {
    p.sentOff = true;
    match.addLog && match.addLog("Kırmızı kart: " + p.name);
  } else {
    p.cards = (p.cards || 0) + 1;
    match.addLog && match.addLog("Sarı kart: " + p.name);
  }
  return { side, player: p.name, red };
}
module.exports = { checkCardEvents };
