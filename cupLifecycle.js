// ============================================================
// cupLifecycle.js — Kupa maçı başlatma/bitirme
// ------------------------------------------------------------
// matchLifecycle.js'in kupa karşılığı. Aynı Match motorunu
// (matchEngine.js) kullanır, sadece sonucu leagueRepo yerine
// cupRepo'ya yazar ve tur ilerletmeyi tetikler.
// ============================================================

const cupRepo = require("./repos/cupRepo");
const clubsRepo = require("./repos/clubsRepo");

let stadiumSystem = null;
let socialSystem = null;
try {
  stadiumSystem = require("./stadiumSystem");
} catch (_) {}
try {
  socialSystem = require("./socialSystem");
} catch (_) {}
let matchArchive = null;
try { matchArchive = require("./matchArchive"); } catch (_) {}
let statsSystem = null;
try { statsSystem = require("./statsSystem"); } catch (_) {}

async function onCupMatchEnd(state, matchInstance) {
  if (!state) return;
  const fixtureId = state.fixtureId;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;
  const matchId = state.id || null;

  let result = null;
  try {
    if (fixtureId) {
      result = await cupRepo.applyMatchResult(fixtureId, homeGoals, awayGoals, matchId);
      if (!result.ok) console.warn("[cupLifecycle] applyMatchResult", result.error);
    }
  } catch (e) {
    console.error("[cupLifecycle] result", e);
  }

  // Bilet geliri — ev sahibi (kupa maçında yarı yarıya paylaşım kuralını
  // stadiumSystem zaten "comp" parametresiyle destekliyorsa kullan)
  try {
    if (fixtureId && stadiumSystem && stadiumSystem.applyMatchTicketRevenue) {
      const fixture = await cupRepo.getFixtureById(fixtureId);
      if (fixture && fixture.homeClubId) {
        await stadiumSystem.applyMatchTicketRevenue(fixture.homeClubId, {
          isHome: true,
          comp: "kupa",
        });
      }
    }
  } catch (e) {
    console.error("[cupLifecycle] tickets", e);
  }

  // Oyuncu gol/asist istatistikleri anında
  try {
    if (statsSystem && typeof statsSystem.recordMatchStats === "function") {
      await statsSystem.recordMatchStats(state, matchInstance || null);
    }
  } catch (e) {
    console.error("[cupLifecycle] stats", e);
  }

  // Not: Maç sonucu bildirimi kasıtlı olarak gönderilmiyor
  // (kullanıcı isteğiyle kaldırıldı — bildirimlere maç skoru gelmesin).

  // Tur tamamlandıysa sıradaki turu (ya da şampiyonu) oluştur
  try {
    const advanced = await cupRepo.advanceReadyEditions();
    if (advanced.length) console.log("[cupLifecycle] advanced", advanced);
  } catch (e) {
    console.error("[cupLifecycle] advance", e);
  }
}

/** matchLifecycle.startFixtureMatch ile aynı iskelet, cupRepo'ya bağlı. */
async function startCupFixtureMatch(opts) {
  const { fixtureId, io, liveMatches, MatchClass } = opts;
  if (!fixtureId || !MatchClass) throw new Error("fixtureId ve MatchClass gerekli");
  if (liveMatches && liveMatches.has(fixtureId)) {
    return liveMatches.get(fixtureId);
  }

  const fixture = await cupRepo.getFixtureById(fixtureId);
  if (!fixture) throw new Error("Kupa fikstürü yok");
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

  const matchId = "cm_" + fixtureId;
  const bothBot = !!playerA.isBot && !!playerB.isBot;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    tickMs: bothBot ? 120 : undefined,
    circulationMs: bothBot ? 100 : undefined,
    onEnd: async (state) => {
      try {
        await onCupMatchEnd(state, match);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await cupRepo.setFixtureLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);

  match.start();
  if (io) {
    io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  }
  return match;
}

module.exports = { onCupMatchEnd, startCupFixtureMatch };
