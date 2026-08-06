// ============================================================
// statsSystem.js — maç bitince istatistik + liderlik tabloları
// ============================================================

const statsRepo = require("./repos/statsRepo");
const leagueRepo = require("./repos/leagueRepo");

/**
 * Match.getPublicState() + canlı Match.players üzerinden
 * gol/asist katkılarını season + month tablolarına yazar.
 */
async function recordMatchStats(state, matchInstance) {
  if (!state || !state.fixtureId) return;

  let seasonId = null;
  try {
    const fixture = await leagueRepo.getFixtureById(state.fixtureId);
    if (!fixture) return; // kupa / milli — sezon istatistiğine yazma
    seasonId = fixture.seasonId;
  } catch (_) {
    return;
  }
  if (!seasonId) return;

  const homeClubId =
    matchInstance && matchInstance.players.home
      ? matchInstance.players.home.clubId
      : null;
  const awayClubId =
    matchInstance && matchInstance.players.away
      ? matchInstance.players.away.clubId
      : null;
  const homeName =
    (state.players && state.players.home && state.players.home.teamName) ||
    "Ev";
  const awayName =
    (state.players && state.players.away && state.players.away.teamName) ||
    "Dep";

  // Oyuncu bazında gol/asist (match memory)
  function collect(side, clubId, clubName) {
    const team =
      matchInstance && matchInstance.players[side]
        ? matchInstance.players[side].team
        : null;
    if (!team) return [];
    const all = [...(team.players || []), ...(team.bench || [])];
    return all
      .filter((p) => p && p.id && ((p.goals || 0) > 0 || (p.assists || 0) > 0))
      .map((p) => ({
        playerId: p.id,
        playerName: p.name,
        clubId,
        clubName,
        goals: Number(p.goals) || 0,
        assists: Number(p.assists) || 0,
      }));
  }

  // Maç içinde goals alanı maç başı 0'dan artıyor olmalı;
  // eğer cumulative DB değeri geldiyse scorers listesinden say.
  let contributions = [
    ...collect("home", homeClubId, homeName),
    ...collect("away", awayClubId, awayName),
  ];

  if (!contributions.length && state.scorers && state.scorers.length) {
    const byName = {};
    for (const s of state.scorers) {
      const key = (s.side || "") + "|" + (s.name || "");
      if (!byName[key]) {
        byName[key] = {
          side: s.side,
          playerName: s.name,
          goals: 0,
          assists: 0,
        };
      }
      byName[key].goals += 1;
      if (s.assist) {
        const akey = (s.side || "") + "|" + s.assist;
        if (!byName[akey]) {
          byName[akey] = {
            side: s.side,
            playerName: s.assist,
            goals: 0,
            assists: 0,
          };
        }
        byName[akey].assists += 1;
      }
    }
    for (const v of Object.values(byName)) {
      const side = v.side === "away" ? "away" : "home";
      const team =
        matchInstance && matchInstance.players[side]
          ? matchInstance.players[side].team
          : null;
      const all = team
        ? [...(team.players || []), ...(team.bench || [])]
        : [];
      const p = all.find((x) => x && x.name === v.playerName);
      contributions.push({
        playerId: p && p.id,
        playerName: v.playerName,
        clubId: side === "home" ? homeClubId : awayClubId,
        clubName: side === "home" ? homeName : awayName,
        goals: v.goals,
        assists: v.assists,
      });
    }
  }

  // MOTM: en çok gol+asist (basit)
  let motmId = null;
  if (contributions.length) {
    const ranked = contributions
      .filter((c) => c.playerId)
      .slice()
      .sort(
        (a, b) =>
          b.goals * 3 +
          b.assists * 2 -
          (a.goals * 3 + a.assists * 2),
      );
    if (ranked[0] && ranked[0].goals + ranked[0].assists > 0) {
      motmId = ranked[0].playerId;
    }
  }

  for (const c of contributions) {
    if (!c.playerId) continue;
    try {
      await statsRepo.addPlayerMatchContribution({
        seasonId,
        playerId: c.playerId,
        clubId: c.clubId,
        playerName: c.playerName,
        clubName: c.clubName,
        goals: c.goals,
        assists: c.assists,
        isMotm: c.playerId === motmId,
      });
    } catch (e) {
      console.warn("[stats] contribution", c.playerName, e.message);
    }
  }
}

async function getLeaderboards(country, division) {
  const season = await leagueRepo.getCurrentSeason(
    country || "Türkiye",
    division || 1,
  );
  if (!season) {
    return {
      season: null,
      goalKing: [],
      assistKing: [],
      playerOfYearPreview: [],
      playerOfMonth: [],
      awards: [],
    };
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const [goals, assists, poty, monthBoard, awards] = await Promise.all([
    statsRepo.topSeason(season.id, "goals", 15),
    statsRepo.topSeason(season.id, "assists", 15),
    statsRepo.topSeason(season.id, "goals", 40),
    statsRepo.topMonth(year, month, "goals", 15),
    statsRepo.listAwards({ seasonId: season.id }),
  ]);

  poty.sort((a, b) => statsRepo.scoreRow(b) - statsRepo.scoreRow(a));

  return {
    season: {
      id: season.id,
      country: season.country,
      division: season.division,
      yearLabel: season.year_label,
    },
    goalKing: goals,
    assistKing: assists,
    playerOfYearPreview: poty.slice(0, 15).map((r) => ({
      ...r,
      score: statsRepo.scoreRow(r),
    })),
    playerOfMonth: monthBoard.map((r) => ({
      ...r,
      score: (Number(r.goals) || 0) * 3 + (Number(r.assists) || 0) * 2,
    })),
    month: { year, month },
    awards,
  };
}

async function finalizeMonth(year, month) {
  return statsRepo.computePlayerOfMonth(year, month);
}

async function finalizeSeason(seasonId) {
  return statsRepo.computeSeasonAwards(seasonId);
}

module.exports = {
  recordMatchStats,
  getLeaderboards,
  finalizeMonth,
  finalizeSeason,
};
