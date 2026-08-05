// Minimal stub — gol şansı düşük rastgele
function attemptShot(match, side) {
  const other = side === "home" ? "away" : "home";
  match.stats[side].shots = (match.stats[side].shots || 0) + 1;
  const onTarget = Math.random() < 0.4;
  if (onTarget) match.stats[side].onTarget = (match.stats[side].onTarget || 0) + 1;
  const scored = onTarget && Math.random() < 0.28;
  if (scored) {
    match.score[side] += 1;
    match.stats[side].goals = (match.stats[side].goals || 0) + 1;
    const team = match.players[side].team;
    const scorer =
      (team.players && team.players.find((p) => /F|ST|CF|SS|W/i.test(p.pos || ""))) ||
      (team.players && team.players[0]) ||
      { name: "Oyuncu" };
    match.scorers.push({
      side,
      name: scorer.name,
      minute: match.minute,
    });
    match.addLog &&
      match.addLog(
        "GOL! " + scorer.name + " (" + match.minute + "') — " +
          match.score.home + "-" + match.score.away,
      );
    match.broadcast &&
      match.broadcast("match:goal", {
        side,
        scorer: scorer.name,
        minute: match.minute,
        score: { ...match.score },
      });
    return { scored: true, scorer: scorer.name };
  }
  match.addLog &&
    match.addLog(
      onTarget
        ? "Şut kaleciye — " + (side === "home" ? "ev" : "dep")
        : "Şut auta / blok",
    );
  return { scored: false };
}
module.exports = { attemptShot };
