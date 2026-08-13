// Mevkiye duyarlı mock kadro (maç motoru fallback)
function clamp(v) {
  return Math.max(4, Math.min(16, Math.round(v * 10) / 10));
}
function mk(pos, i, name) {
  const p = String(pos || "MC").toUpperCase();
  const base = 8.5 + Math.random() * 1.5;
  const j = (m, primary) =>
    clamp(base + m + (Math.random() - 0.5) * (primary ? 1.4 : 2.2));
  const isGk = p === "GK";
  const mods = {
    GK:  { pace: -2, passing: -0.8, finishing: -3.5, tackle: -2, vision: -0.5, stamina: -0.4, strength: 0.3, technique: -0.4, agility: 1.2, positioning: 2.0, reflex: 3.8, handling: 3.6 },
    DC:  { pace: -0.7, passing: -0.5, finishing: -2.5, tackle: 2.8, vision: -0.6, stamina: 1.0, strength: 2.2, technique: -0.5, agility: -0.5, positioning: 2.8, reflex: -2.8, handling: -3.5 },
    DL:  { pace: 1.3, passing: 0.2, finishing: -2, tackle: 2.0, vision: -0.3, stamina: 1.1, strength: 0.5, technique: 0.2, agility: 1.0, positioning: 1.6, reflex: -2.8, handling: -3.5 },
    DR:  { pace: 1.3, passing: 0.2, finishing: -2, tackle: 2.0, vision: -0.3, stamina: 1.1, strength: 0.5, technique: 0.2, agility: 1.0, positioning: 1.6, reflex: -2.8, handling: -3.5 },
    DM:  { pace: -0.3, passing: 1.3, finishing: -1.8, tackle: 2.2, vision: 0.7, stamina: 1.4, strength: 1.1, technique: 0.3, agility: -0.2, positioning: 1.4, reflex: -2.8, handling: -3.5 },
    MC:  { pace: 0.2, passing: 2.2, finishing: -0.7, tackle: 0.5, vision: 2.0, stamina: 1.2, strength: 0.1, technique: 1.4, agility: 0.3, positioning: 0.7, reflex: -2.8, handling: -3.5 },
    ML:  { pace: 1.6, passing: 1.1, finishing: 0.2, tackle: -0.5, vision: 0.7, stamina: 1.0, strength: -0.3, technique: 1.2, agility: 1.5, positioning: 0.2, reflex: -2.8, handling: -3.5 },
    MR:  { pace: 1.6, passing: 1.1, finishing: 0.2, tackle: -0.5, vision: 0.7, stamina: 1.0, strength: -0.3, technique: 1.2, agility: 1.5, positioning: 0.2, reflex: -2.8, handling: -3.5 },
    OMC: { pace: 0.3, passing: 2.4, finishing: 1.1, tackle: -1.1, vision: 2.5, stamina: 0.5, strength: -0.3, technique: 2.0, agility: 0.7, positioning: 0.5, reflex: -2.8, handling: -3.5 },
    FL:  { pace: 2.2, passing: 0.5, finishing: 1.4, tackle: -1.4, vision: 0.3, stamina: 0.7, strength: -0.5, technique: 1.4, agility: 2.0, positioning: 0.2, reflex: -2.8, handling: -3.5 },
    FR:  { pace: 2.2, passing: 0.5, finishing: 1.4, tackle: -1.4, vision: 0.3, stamina: 0.7, strength: -0.5, technique: 1.4, agility: 2.0, positioning: 0.2, reflex: -2.8, handling: -3.5 },
    FC:  { pace: 0.7, passing: -0.3, finishing: 3.0, tackle: -1.8, vision: 0.2, stamina: 0.7, strength: 1.6, technique: 1.2, agility: 0.5, positioning: 1.4, reflex: -2.8, handling: -3.5 },
  }[p] || { pace: 0, passing: 0.5, finishing: 0, tackle: 0, vision: 0.5, stamina: 0.5, strength: 0, technique: 0.5, agility: 0.3, positioning: 0.3, reflex: -2.8, handling: -3.5 };
  const m = mods;
  return {
    name: (name || "Bot") + " " + (i + 1),
    pos,
    naturalPos: pos,
    number: i + 1,
    age: 20 + (i % 12),
    pace: j(m.pace, ["FL","FR","ML","MR","DL","DR"].includes(p)),
    passing: j(m.passing, ["MC","OMC","DM"].includes(p)),
    finishing: j(m.finishing, ["FC","FL","FR"].includes(p)),
    tackle: j(m.tackle, ["DC","DL","DR","DM"].includes(p)),
    vision: j(m.vision, ["MC","OMC","DM"].includes(p)),
    stamina: j(m.stamina, true),
    strength: j(m.strength, ["DC","FC","DM"].includes(p)),
    technique: j(m.technique, ["OMC","MC","FL","FR","FC"].includes(p)),
    agility: j(m.agility, isGk || ["FL","FR"].includes(p)),
    positioning: j(m.positioning, isGk || ["DC","DL","DR"].includes(p)),
    reflex: isGk ? j(m.reflex, true) : clamp(4 + Math.random() * 3),
    handling: isGk ? j(m.handling, true) : clamp(3 + Math.random() * 2),
    condition: 90,
  };
}
function createMockSquad(name) {
  const positions = [
    "GK","DL","DC","DC","DR","DM","MC","MC","OMC","FL","FR",
  ];
  const benchPos = ["GK","DC","MC","FC","ML","MR","DM"];
  return {
    name: name || "Bot FC",
    players: positions.map((p, i) => mk(p, i, name)),
    bench: benchPos.map((p, i) => mk(p, i + 11, name)),
  };
}
module.exports = { createMockSquad };
