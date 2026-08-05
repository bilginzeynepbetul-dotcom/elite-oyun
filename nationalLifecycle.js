// ============================================================
// nationalLifecycle.js — Milli maçları başlatır / bitirir
// matchLifecycle.js ile aynı desen (bkz. o dosyadaki yorumlar).
// ============================================================

const nationalRepo = require("./repos/nationalRepo");
const nationalSystem = require("./nationalSystem");
const { COUNTRY } = require("./nationalRoutes");

let socialSystem = null;
try {
  socialSystem = require("./socialSystem");
} catch (_) {}

const OPP_FIRST = [
  "Marco", "Luca", "Hans", "Jan", "Pierre", "Antoine", "Erik", "Lukas",
  "Diego", "Pablo", "Nuno", "Rui", "Kevin", "Tom", "Max", "Leon",
  "Ivan", "Marko", "Milan", "Viktor", "Yuto", "Kenji", "Amadou", "Youssef",
];
const OPP_LAST = [
  "Müller", "Schmidt", "Rossi", "Bianchi", "Dubois", "Martin", "García",
  "López", "Silva", "Santos", "Kowalski", "Novak", "Petrov", "Ivanov",
  "Andersson", "Johansson", "Hansen", "Jensen", "Smith", "Brown",
];
const POSITIONS_18 = [
  "GK", "DL", "DC", "DC", "DR", "DM", "MC", "MC", "OMC", "FL", "FR",
  "GK", "DC", "MC", "FC", "ML", "MR", "DM",
];

function rnd(base, spread) {
  return base + (Math.random() - 0.5) * spread;
}

/** "Dünya botu" milli takım kadrosu üretir (persist edilmez, sadece maç için). */
function buildOpponentTeam(name, strength) {
  const base = 7 + (strength / 100) * 14; // strength 55-85 → base ~14-19
  const makePlayer = (pos, idx) => ({
    id: "opp_" + name + "_" + idx,
    name:
      OPP_FIRST[Math.floor(Math.random() * OPP_FIRST.length)] +
      " " +
      OPP_LAST[Math.floor(Math.random() * OPP_LAST.length)],
    number: idx + 1,
    pos,
    naturalPos: pos,
    age: 20 + Math.floor(Math.random() * 12),
    pace: rnd(base, 4),
    passing: rnd(base, 4),
    finishing: rnd(base, 4),
    tackle: rnd(base, 4),
    vision: rnd(base, 4),
    stamina: rnd(base, 3),
    strength: rnd(base, 4),
    technique: rnd(base, 4),
    agility: rnd(base, 4),
    positioning: rnd(base, 4),
    reflex: rnd(base, 4),
    handling: rnd(base, 4),
    condition: 88 + Math.floor(Math.random() * 12),
    form: 0,
    experience: 5 + Math.random() * 5,
    happiness: 80,
  });
  const all = POSITIONS_18.map((pos, i) => makePlayer(pos, i));
  return {
    name: name + " Milli Takımı",
    gameStyle: "dengeli",
    passStyle: "kısa",
    attackDir: "orta",
    currentFormation: "4-4-2",
    players: all.slice(0, 11),
    bench: all.slice(11),
  };
}

async function startNationalFixtureMatch(opts) {
  const { fixtureId, io, liveMatches, MatchClass } = opts;
  if (liveMatches && liveMatches.has(fixtureId)) return liveMatches.get(fixtureId);

  const fixture = await nationalRepo.getFixtureById(fixtureId);
  if (!fixture) throw new Error("Milli fikstür yok");
  if (fixture.status === "finished") throw new Error("Maç zaten bitmiş");

  const squad = await nationalRepo.getSquadForMatch(fixture.nationalTeamId);
  if (!squad.starters.length) {
    throw new Error("Kadroda çağrılmış ilk 11 yok — TD kadro belirlemeli");
  }

  const team = await nationalRepo.getTeamById(fixture.nationalTeamId);
  const homeTeam = {
    name: (team && team.country) + " Milli Takımı",
    gameStyle: (team && team.gameStyle) || "dengeli",
    passStyle: "kısa",
    attackDir: "orta",
    currentFormation: (team && team.formation) || "4-4-2",
    players: squad.starters,
    bench: squad.bench,
  };
  const awayTeam = buildOpponentTeam(fixture.opponentName, fixture.opponentStrength);

  const playerA = {
    userId: team ? "nat:" + team.id : null,
    username: homeTeam.name,
    socketId: null,
    team: homeTeam,
    isBot: false,
    clubId: null,
  };
  const playerB = {
    userId: null,
    username: awayTeam.name,
    socketId: null,
    team: awayTeam,
    isBot: true,
    clubId: null,
  };

  const matchId = "nm_" + fixtureId;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    onEnd: async (state) => {
      try {
        await onNationalMatchEnd(state, fixture);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await nationalRepo.setFixtureLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);

  match.start();
  if (io) io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  return match;
}

async function onNationalMatchEnd(state, fixture) {
  if (!state) return;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;

  try {
    await nationalRepo.finishFixture(fixture.id, homeGoals, awayGoals);
  } catch (e) {
    console.error("[nationalLifecycle] finishFixture", e);
  }

  try {
    const team = await nationalRepo.getTeamById(fixture.nationalTeamId);
    if (team && team.managerUserId && socialSystem && socialSystem.pushNotification) {
      await socialSystem.pushNotification(
        team.managerUserId,
        "🏳️",
        `Milli maç bitti: ${team.country} ${homeGoals} - ${awayGoals} ${fixture.opponentName}`,
        "Milli Takım",
      );
    }
  } catch (e) {
    console.error("[nationalLifecycle] notify", e);
  }

  try {
    await nationalSystem.scheduleNextFixtureIfNeeded(COUNTRY);
  } catch (e) {
    console.error("[nationalLifecycle] reschedule", e);
  }

  console.log(
    `[nationalLifecycle] BİTTİ ${fixture.opponentName} maçı ${homeGoals}-${awayGoals}`,
  );
}

module.exports = { startNationalFixtureMatch, onNationalMatchEnd };
