function checkCardEvents(match) {
  // ~0.35 kart olayı / maç; kırmızı oranı düşük tutulur
  if (Math.random() > 0.0035) return null;
  const side = Math.random() < 0.5 ? "home" : "away";
  const team = match.players[side].team;
  const pool = (team.players || []).filter((x) => x && !x.sentOff && !x.injured);
  if (!pool.length) return null;
  // Müdahale skoru yüksek olanlar biraz daha riskli
  const weight = (p) => 1 + (Number(p.tackle) || 8) * 0.08;
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
    match.addLog &&
      match.addLog(
        mt(wasSecond ? "second_yellow" : "red", lang, { name: p.name }),
      );
  } else {
    p.cards = (p.cards || 0) + 1;
    match.addLog && match.addLog(mt("yellow", lang, { name: p.name }));
  }
  return { side, player: p.name, red: !!p.sentOff };
}
module.exports = { checkCardEvents };
