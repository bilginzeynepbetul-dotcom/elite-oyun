// ============================================================
// continentalLifecycle.js — Kıtalar Ligi maç başlat / bitir
// ============================================================

const continentalRepo = require("./repos/continentalRepo");
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

async function onContinentalMatchEnd(state, matchInstance) {
  if (!state) return;
  const fixtureId = state.fixtureId;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;
  const matchId = state.id || null;

  try {
    if (fixtureId) {
      const result = await continentalRepo.applyMatchResult(
        fixtureId,
        homeGoals,
        awayGoals,
        matchId,
      );
      if (!result.ok) {
        console.warn("[clLifecycle] applyMatchResult", result.error);
      } else if (result.editionId) {
        try {
          await continentalRepo.maybeAdvanceKnockout(result.editionId);
        } catch (e) {
          console.error("[clLifecycle] advance", e);
        }
      }
    }
  } catch (e) {
    console.error("[clLifecycle] result", e);
  }

  try {
    if (matchArchive && fixtureId) {
      const fixture = await continentalRepo.getFixtureById(fixtureId);
      await matchArchive.persistMatch(state, matchInstance || null, {
        competition: "continental",
        fixtureId,
        homeClubId: fixture && fixture.homeClubId,
        awayClubId: fixture && fixture.awayClubId,
        homeName: fixture && fixture.homeName,
        awayName: fixture && fixture.awayName,
      });
    }
  } catch (e) {
    console.error("[clLifecycle] archive", e);
  }

  try {
    if (fixtureId && stadiumSystem && stadiumSystem.applyMatchTicketRevenue) {
      const fixture = await continentalRepo.getFixtureById(fixtureId);
      if (fixture && fixture.homeClubId) {
        await stadiumSystem.applyMatchTicketRevenue(fixture.homeClubId, {
          isHome: true,
          comp: "kita",
        });
      }
    }
  } catch (e) {
    console.error("[clLifecycle] tickets", e);
  }

  try {
    if (statsSystem && typeof statsSystem.recordMatchStats === "function") {
      await statsSystem.recordMatchStats(state, matchInstance || null);
    }
  } catch (e) {
    console.error("[clLifecycle] stats", e);
  }

  try {
    if (matchRewards && typeof matchRewards.applyMatchRewards === "function") {
      await matchRewards.applyMatchRewards({
        kind: "continental",
        state,
        matchInstance: matchInstance || null,
      });
    }
  } catch (e) {
    console.error("[clLifecycle] rewards", e);
  }
}

async function startContinentalFixtureMatch(opts) {
  const { fixtureId, io, liveMatches, MatchClass } = opts;
  if (!fixtureId || !MatchClass) throw new Error("fixtureId ve MatchClass gerekli");
  if (liveMatches && liveMatches.has(fixtureId)) {
    return liveMatches.get(fixtureId);
  }

  const fixture = await continentalRepo.getFixtureById(fixtureId);
  if (!fixture) throw new Error("CL fikstürü yok");
  if (fixture.status === "finished") throw new Error("Maç zaten bitmiş");

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

  const matchId = "cl_" + fixtureId;
  const bothBot = !!playerA.isBot && !!playerB.isBot;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    tickMs: bothBot ? 120 : undefined,
    circulationMs: bothBot ? 100 : undefined,
    onEnd: async (state) => {
      try {
        await onContinentalMatchEnd(state, match);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await continentalRepo.setFixtureLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);
  match.start();
  if (io) {
    io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  }
  return match;
}

module.exports = {
  onContinentalMatchEnd,
  startContinentalFixtureMatch,
};
