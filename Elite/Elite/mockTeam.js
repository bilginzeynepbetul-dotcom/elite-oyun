function createMockSquad(name) {
  const positions = [
    "GK","DL","DC","DC","DR","DM","MC","MC","OMC","FL","FR",
  ];
  const benchPos = ["GK","DC","MC","FC","ML","MR","DM"];
  const mk = (pos, i) => ({
    name: (name || "Bot") + " " + (i + 1),
    pos,
    number: i + 1,
    age: 22,
    pace: 11, passing: 11, finishing: 11, tackle: 11, vision: 11,
    stamina: 11, strength: 11, technique: 11, agility: 11, positioning: 11,
    reflex: 11, handling: 11, condition: 90,
  });
  return {
    name: name || "Bot FC",
    players: positions.map((p, i) => mk(p, i)),
    bench: benchPos.map((p, i) => mk(p, i + 11)),
  };
}
module.exports = { createMockSquad };
