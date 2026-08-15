// ============================================================
// matchLifecycle.js — Maç bitince standings + ekonomi + bildirim
// ------------------------------------------------------------
// Match constructor options.onEnd yerine bunu kullan:
//
//   const { onMatchEnd, startFixtureMatch } = require("./matchLifecycle");
//   const match = new Match(id, playerA, playerB, io, {
//     fixtureId,
//     onEnd: onMatchEnd,
//   });
// ============================================================

const leagueRepo = require("./repos/leagueRepo");
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
try {
  matchArchive = require("./matchArchive");
} catch (_) {}
let matchRewards = null;
try {
  matchRewards = require("./matchRewards");
} catch (_) {}
let statsSystem = null;
try {
  statsSystem = require("./statsSystem");
} catch (_) {}

/**
 * Match.getPublicState() şeklindeki state ile çağrılır.
 * matchEngine.Match end() → this.onEnd(state)
 */
async function onMatchEnd(state, matchInstance) {
  if (!state) return;
  const fixtureId = state.fixtureId;
  const homeGoals = state.score ? state.score.home : 0;
  const awayGoals = state.score ? state.score.away : 0;
  const matchId = state.id || null;

  try {
    if (fixtureId) {
      const result = await leagueRepo.applyMatchResult(
        fixtureId,
        homeGoals,
        awayGoals,
        matchId,
      );
      if (!result.ok) {
        console.warn("[matchLifecycle] applyMatchResult", result.error);
      } else {
        console.log(
          "[matchLifecycle] result applied",
          fixtureId,
          homeGoals + "-" + awayGoals,
        );
      }
    }
  } catch (e) {
    console.error("[matchLifecycle] standings", e);
  }

  // Veritabanı arşivi: skor + stats + scorers + log
  try {
    if (matchArchive && fixtureId) {
      const fixture = await leagueRepo.getFixtureById(fixtureId);
      await matchArchive.persistMatch(state, matchInstance || null, {
        competition: "league",
        fixtureId,
        homeClubId: fixture && fixture.homeClubId,
        awayClubId: fixture && fixture.awayClubId,
        homeName: fixture && fixture.homeName,
        awayName: fixture && fixture.awayName,
      });
    }
  } catch (e) {
    console.error("[matchLifecycle] archive", e);
  }

  // Bilet geliri — ev sahibi + maç primi (her iki taraf)
  try {
    if (fixtureId) {
      const fixture = await leagueRepo.getFixtureById(fixtureId);
      let homeRes = "draw";
      if (homeGoals > awayGoals) homeRes = "win";
      else if (awayGoals > homeGoals) homeRes = "loss";
      if (
        fixture &&
        fixture.homeClubId &&
        stadiumSystem &&
        stadiumSystem.applyMatchTicketRevenue
      ) {
        const eco = await stadiumSystem.applyMatchTicketRevenue(
          fixture.homeClubId,
          { isHome: true, comp: "lig", result: homeRes },
        );
        console.log(
          "[matchLifecycle] tickets",
          fixture.homeClubId,
          eco && eco.tickets,
        );
      }
      try {
        const { applyMatchPrizeMoney } = require("./economyBalance");
        const prizes = await applyMatchPrizeMoney({
          kind: "league",
          homeGoals,
          awayGoals,
          homeClubId: fixture && fixture.homeClubId,
          awayClubId: fixture && fixture.awayClubId,
          division: fixture && fixture.division,
        });
        console.log("[matchLifecycle] prizes", prizes);
      } catch (ePrize) {
        console.error("[matchLifecycle] prizes", ePrize);
      }
    }
  } catch (e) {
    console.error("[matchLifecycle] tickets", e);
  }

  // Oyuncu sezon/ay gol-asist liderlik istatistikleri
  try {
    if (statsSystem && typeof statsSystem.recordMatchStats === "function") {
      await statsSystem.recordMatchStats(state, matchInstance || null);
      console.log("[matchLifecycle] player stats recorded", fixtureId || matchId);
    }
  } catch (e) {
    console.error("[matchLifecycle] stats", e);
  }

  // Maç ödülleri (tecrübe / antrenman etkisi)
  try {
    if (matchRewards && typeof matchRewards.applyMatchRewards === "function") {
      await matchRewards.applyMatchRewards({
        kind: "league",
        state,
        matchInstance: matchInstance || null,
      });
      console.log("[matchLifecycle] rewards applied", fixtureId || matchId);
    }
  } catch (e) {
    console.error("[matchLifecycle] rewards", e);
  }

  // Sakatlıkları kalıcılaştır + doktor ile iyileşme adımı
  try {
    const staffSystem = require("./staffSystem");
    const homeClubId =
      (matchInstance &&
        matchInstance.players &&
        matchInstance.players.home &&
        matchInstance.players.home.clubId) ||
      null;
    const awayClubId =
      (matchInstance &&
        matchInstance.players &&
        matchInstance.players.away &&
        matchInstance.players.away.clubId) ||
      null;
    const homePlayers =
      (state.players &&
        state.players.home &&
        state.players.home.team &&
        state.players.home.team.players) ||
      (matchInstance &&
        matchInstance.players &&
        matchInstance.players.home &&
        matchInstance.players.home.team &&
        matchInstance.players.home.team.players) ||
      [];
    const awayPlayers =
      (state.players &&
        state.players.away &&
        state.players.away.team &&
        state.players.away.team.players) ||
      (matchInstance &&
        matchInstance.players &&
        matchInstance.players.away &&
        matchInstance.players.away.team &&
        matchInstance.players.away.team.players) ||
      [];
    if (homeClubId) {
      await staffSystem.persistMatchInjuries(homeClubId, homePlayers);
      await staffSystem.processRecovery(homeClubId);
    }
    if (awayClubId) {
      await staffSystem.persistMatchInjuries(awayClubId, awayPlayers);
      await staffSystem.processRecovery(awayClubId);
    }
  } catch (eInj) {
    console.warn("[matchLifecycle] injury/doctor", eInj.message);
  }

  // Sezon kapanışı: tüm lig maçları bittiyse şampiyon + ödül + yeni sezon
  try {
    if (fixtureId) {
      const seasonLifecycle = require("./seasonLifecycle");
      const fin = await seasonLifecycle.tryFinalizeAfterLeagueMatch(fixtureId);
      if (fin && fin.ok && !fin.skipped) {
        console.log(
          "[matchLifecycle] season finalized",
          fin.country,
          fin.yearLabel,
          "champion=",
          fin.champion && fin.champion.name,
        );
        // Canlı istemcilere bildir — UI standings/history yenilesin
        try {
          const io = matchInstance && matchInstance.io;
          const payload = {
            country: fin.country,
            division: fin.division,
            yearLabel: fin.yearLabel,
            champion: fin.champion || null,
            seasonId: fin.seasonId,
            nextSeason: fin.nextSeason
              ? { id: fin.nextSeason.id, yearLabel: fin.nextSeason.year_label || fin.nextSeason.yearLabel }
              : null,
          };
          if (io && typeof io.emit === "function") {
            io.emit("season:finalized", payload);
          }
        } catch (eEmit) {
          console.warn("[matchLifecycle] season emit", eEmit.message);
        }
        // Ligdeki insan menajerlere bildirim
        try {
          if (socialSystem && typeof socialSystem.pushNotification === "function" && fin.standings) {
            const clubsRepo = require("./repos/clubsRepo");
            for (const row of fin.standings) {
              if (!row.clubId) continue;
              try {
                const club = await clubsRepo.getClub(row.clubId);
                if (club && club.user_id && !club.is_bot) {
                  await socialSystem.pushNotification(
                    club.user_id,
                    "🏆",
                    (fin.yearLabel || "Sezon") +
                      " bitti · Şampiyon: " +
                      ((fin.champion && fin.champion.name) || "—"),
                    "Lig",
                  );
                }
              } catch (_) {}
            }
          }
        } catch (eNotif) {
          console.warn("[matchLifecycle] season notif", eNotif.message);
        }
      }
    }
  } catch (e) {
    console.error("[matchLifecycle] seasonFinalize", e);
  }

  // Not: Maç sonucu bildirimi kasıtlı olarak gönderilmiyor
  // (kullanıcı isteğiyle kaldırıldı — bildirimlere maç skoru gelmesin).

  // Günlük görevler
  try {
    const dailyChallengeSystem = require("./dailyChallengeSystem");
    const hg =
      (state && state.score && state.score.home) != null
        ? Number(state.score.home)
        : 0;
    const ag =
      (state && state.score && state.score.away) != null
        ? Number(state.score.away)
        : 0;
    for (const side of [
      { clubId: homeClubId, gf: hg, ga: ag },
      { clubId: awayClubId, gf: ag, ga: hg },
    ]) {
      if (!side.clubId) continue;
      const uid = await dailyChallengeSystem.userIdForClub(side.clubId);
      if (!uid) continue;
      await dailyChallengeSystem.onMatchPlayed(uid, {
        won: side.gf > side.ga,
        goals: side.gf,
      });
    }
  } catch (eCh) {
    console.warn("[matchLifecycle] challenges", eCh.message);
  }

  // Form / kondisyon kalıcılığı
  try {
    const playerFormSystem = require("./playerFormSystem");
    await playerFormSystem.applyPostMatchForm(state, matchInstance, {
      homeClubId,
      awayClubId,
    });
  } catch (eForm) {
    console.warn("[matchLifecycle] form", eForm.message);
  }

  // Başarılar
  try {
    const achievementsSystem = require("./achievementsSystem");
    const hg = (state && state.score && state.score.home) || 0;
    const ag = (state && state.score && state.score.away) || 0;
    await achievementsSystem.onMatchResult({
      homeClubId: homeClubId,
      awayClubId: awayClubId,
      homeGoals: hg,
      awayGoals: ag,
      competition: "league",
    });
  } catch (eAch) {
    console.warn("[matchLifecycle] achievements", eAch.message);
  }
}

/**
 * Fikstürden canlı maç başlatma yardımcı iskeleti.
 * liveMatches Map'e yazar; matchEngine.Match dışarıdan verilir.
 *
 * @param {object} opts
 * @param {string} opts.fixtureId
 * @param {object} opts.io - socket.io namespace/server
 * @param {Map} opts.liveMatches - fixtureId → Match
 * @param {typeof import("./matchEngine").Match} opts.MatchClass
 * @param {object} [opts.repo] - getFixtureById/setFixtureLive sağlayan depo (varsayılan: leagueRepo)
 * @param {(state, matchInstance) => Promise<void>} [opts.onEndFn] - maç bitince çağrılır (varsayılan: onMatchEnd)
 */
async function startFixtureMatch(opts) {
  const {
    fixtureId,
    io,
    liveMatches,
    MatchClass,
    repo = leagueRepo,
    onEndFn = onMatchEnd,
  } = opts;
  if (!fixtureId || !MatchClass) throw new Error("fixtureId ve MatchClass gerekli");
  if (liveMatches && liveMatches.has(fixtureId)) {
    return liveMatches.get(fixtureId);
  }

  const fixture = await repo.getFixtureById(fixtureId);
  if (!fixture) throw new Error("Fikstür yok");
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

  const matchId = "m_" + fixtureId;
  const bothBot = !!playerA.isBot && !!playerB.isBot;
  const match = new MatchClass(matchId, playerA, playerB, io, {
    fixtureId,
    // Bot-bot maçlar gerçek zamanı yormadan çabuk bitsin
    tickMs: bothBot ? 120 : undefined,
    circulationMs: bothBot ? 100 : undefined,
    onEnd: async (state) => {
      try {
        await onEndFn(state, match);
      } finally {
        if (liveMatches) liveMatches.delete(fixtureId);
      }
    },
  });

  await repo.setFixtureLive(fixtureId, matchId);
  if (liveMatches) liveMatches.set(fixtureId, match);

  match.start();
  if (io) {
    io.to("fixture:" + fixtureId).emit("fixture:live", { fixtureId });
  }
  // Maç başladı bildirimi (insan menajerler)
  try {
    const { notifyMatchStarted } = require("./matchNotify");
    notifyMatchStarted({ fixtureId }).catch(function () {});
  } catch (_) {}
  return match;
}

module.exports = { onMatchEnd, startFixtureMatch };
