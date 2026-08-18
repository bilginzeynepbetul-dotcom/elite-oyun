// ============================================================
// eliteCupLifecycle.js — Elite Kupa maç başlat / bitir
// ============================================================

const eliteCupRepo = require("./repos/eliteCupRepo");
const clubsRepo = require("./repos/clubsRepo");

let matchArchive = null;
try {
  matchArchive = require("./matchArchive");
} catch (_) {}
let statsSystem = null;
try {
  statsSystem = require("./statsSystem");
} catch (_) {}
let matchRewards = null;
try {
  matchRewards = require("./matchRewards");
} catch (_) {}
let stadiumSystem = null;
try {
  stadiumSystem = require("./stadiumSystem");
} catch (_) {}

async function onEliteCupMatchEnd(state, matchInstance) {
  if (!state) return;
  const fixtureId = state.fixtureId;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;
  const matchId = state.id || null;

  try {
    if (fixtureId) {
      const penOpts = {};
      if (
        state.penalties ||
        state.penaltyWinner ||
        (matchInstance && matchInstance.penalties)
      ) {
        penOpts.penaltyWinner =
          state.penaltyWinner ||
          (matchInstance && matchInstance.penaltyWinner) ||
          null;
        penOpts.penaltyScore =
          state.penaltyScore ||
          (matchInstance && matchInstance.penaltyScore) ||
          null;
      }
      const result = await eliteCupRepo.applyMatchResult(
        fixtureId,
        homeGoals,
        awayGoals,
        matchId,
        penOpts,
      );
      if (!result.ok) {
        console.warn("[eliteCup] applyMatchResult", result.error);
      } else if (result.editionId) {
        try {
          await eliteCupRepo.advanceReadyEditions();
        } catch (e) {
          console.error("[eliteCup] advance", e);
        }
      }
    }
  } catch (e) {
    console.error("[eliteCup] result", e);
  }

  try {
    if (matchArchive && fixtureId) {
      const fixture = await eliteCupRepo.getFixtureById(fixtureId);
      await matchArchive.persistMatch(state, matchInstance || null, {
        competition: "elite_cup",
        fixtureId,
        homeClubId: fixture && fixture.homeClubId,
        awayClubId: fixture && fixture.awayClubId,
        homeName: fixture && fixture.homeName,
        awayName: fixture && fixture.awayName,
      });
    }
  } catch (e) {
    console.error("[eliteCup] archive", e);
  }

  try {
    if (fixtureId && stadiumSystem && stadiumSystem.applyMatchTicketRevenue) {
      const fixture = await eliteCupRepo.getFixtureById(fixtureId);
      let homeRes = "draw";
      if (homeGoals > awayGoals) homeRes = "win";
      else if (awayGoals > homeGoals) homeRes = "loss";
      if (fixture && fixture.homeClubId) {
        await stadiumSystem.applyMatchTicketRevenue(fixture.homeClubId, {
          isHome: true,
          comp: "elite_cup",
          result: homeRes,
        });
      }
    }
  } catch (e) {
    console.error("[eliteCup] tickets", e);
  }

  try {
    if (statsSystem && typeof statsSystem.recordMatchStats === "function") {
      await statsSystem.recordMatchStats(state, matchInstance || null);
    }
  } catch (e) {
    console.error("[eliteCup] stats", e);
  }

  try {
    if (matchRewards && typeof matchRewards.applyMatchRewards === "function") {
      await matchRewards.applyMatchRewards({
        kind: "elite_cup",
        state,
        matchInstance: matchInstance || null,
      });
    }
  } catch (e) {
    console.error("[eliteCup] rewards", e);
  }
}

async function startEliteCupFixtureMatch(opts) {
  const { fixtureId, io, liveMatches, MatchClass } = opts;
  if (!fixtureId || !MatchClass) throw new Error("fixtureId ve MatchClass gerekli");
  if (liveMatches && liveMatches.has(fixtureId)) {
    return liveMatches.get(fixtureId);
  }

  const fixture = await eliteCupRepo.getFixtureById(fixtureId);
  if (!fixture) throw new Error("Elite Kupa fikstürü yok");
  if (fixture.status === "finished" || fixture.status === "bye") {
    throw new Error("Maç zaten bitmiş");
  }
  if (!fixture.homeClubId || !fixture.awayClubId) {
    throw new Error("Bye / eksik rakip");
  }

  const homeTeam = await clubsRepo.getTeam(fixture.homeClubId);
  const awayTeam = await clubsRepo.getTeam(fixture.awayClubId);
  if (!homeTeam || !awayTeam) throw new Error("Takım kadrosu eksik");

  const homeClub = await clubsRepo.getClub(fixture.homeClubId);
  const awayClub = await clubsRepo.getClub(fixture.awayClubId);

  const playerA = {
    userId: homeClub ? homeClub.user_id : null,
    username: homeTeam.name,
    socketId: null,
    team: homeTeam,
    isBot: !homeClub || !homeClub.user_id,
    clubId: fixture.homeClubId,
  };
  const playerB = {
    userId: awayClub ? awayClub.user_id : null,
    username: awayTeam.name,
    socketId: null,
    team: awayTeam,
    isBot: !awayClub || !awayClub.user_id,
    clubId: fixture.awayClubId,
  };

  const matchId = "ek_" + fixtureId;
  const bothBot = !!playerA.isBot && !!playerB.isBot;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    competition: "elite_cup",
    maxTime: 120,
    extraTimeOnDraw: true,
    allowPenalties: true,
    tickMs: bothBot ? 120 : undefined,
    circulationMs: bothBot ? 100 : undefined,
    onEnd: async (state) => {
      try {
        await onEliteCupMatchEnd(state, match);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await eliteCupRepo.setFixtureLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);
  match.start();
  if (io) {
    io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  }
  return match;
}

module.exports = {
  onEliteCupMatchEnd,
  startEliteCupFixtureMatch,
};
