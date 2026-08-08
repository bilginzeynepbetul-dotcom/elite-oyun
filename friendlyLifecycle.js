// ============================================================
// friendlyLifecycle.js — Hazırlık maçı başlatma/bitirme
// ------------------------------------------------------------
// matchLifecycle.js / cupLifecycle.js'in hazırlık maçı karşılığı.
// Aynı Match motorunu (matchEngine.js) kullanır, sonucu
// friendlySystem üzerinden friendly_fixtures tablosuna yazar.
// ============================================================

const friendlySystem = require("./friendlySystem");
const clubsRepo = require("./repos/clubsRepo");

let stadiumSystem = null;
try {
  stadiumSystem = require("./stadiumSystem");
} catch (_) {}
let matchArchive = null;
try {
  matchArchive = require("./matchArchive");
} catch (_) {}

async function onFriendlyMatchEnd(state) {
  if (!state) return;
  const fixtureId = state.fixtureId;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;

  try {
    if (fixtureId) {
      await friendlySystem.finish(fixtureId, homeGoals, awayGoals);
    }
  } catch (e) {
    console.error("[friendlyLifecycle] finish", e);
  }

  try {
    if (matchArchive && fixtureId) {
      const fixture = await friendlySystem.getById(fixtureId);
      await matchArchive.persistMatch(state, null, {
        competition: "friendly",
        fixtureId,
        homeClubId: fixture && fixture.homeClubId,
        awayClubId: fixture && fixture.awayClubId,
      });
    }
  } catch (e) {
    console.error("[friendlyLifecycle] archive", e);
  }

  // Hazırlık maçında bilet geliri yok (kasıtlı) — sadece tecrübe/moral amaçlı.
}

/** matchLifecycle.startFixtureMatch ile aynı iskelet, friendlySystem'e bağlı. */
async function startFriendlyFixtureMatch(opts) {
  const { fixtureId, io, liveMatches, MatchClass } = opts;
  if (!fixtureId || !MatchClass) throw new Error("fixtureId ve MatchClass gerekli");
  if (liveMatches && liveMatches.has(fixtureId)) {
    return liveMatches.get(fixtureId);
  }

  const fixture = await friendlySystem.getById(fixtureId);
  if (!fixture) throw new Error("Hazırlık maçı fikstürü yok");
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

  const matchId = "fm_" + fixtureId;
  const bothBot = !!playerA.isBot && !!playerB.isBot;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    tickMs: bothBot ? 120 : undefined,
    circulationMs: bothBot ? 100 : undefined,
    onEnd: async (state) => {
      try {
        await onFriendlyMatchEnd(state);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await friendlySystem.setLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);

  match.start();
  if (io) {
    io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  }
  return match;
}

module.exports = { onFriendlyMatchEnd, startFriendlyFixtureMatch };
