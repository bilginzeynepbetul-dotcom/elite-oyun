// ============================================================
// seasonLifecycle.js — sezon kapanışı / yükselme-düşme / ödüller
// ============================================================

const { query, withTransaction } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const clubsRepo = require("./repos/clubsRepo");
const statsRepo = require("./repos/statsRepo");
const socialSystem = require("./socialSystem");

function prizeForRank(rank, division) {
  let base = 0;
  if (rank === 1) base = 500000;
  else if (rank === 2) base = 250000;
  else if (rank === 3) base = 125000;
  else return 0;
  if (division >= 3) base = Math.round(base * 0.5);
  else if (division === 2) base = Math.round(base * 0.75);
  return base;
}

function nextYearLabel(label) {
  // "2025/26" → "2026/27"
  const m = String(label || "").match(/(\d{4})\s*\/\s*(\d{2,4})/);
  if (!m) {
    const y = new Date().getFullYear();
    return y + "/" + String((y + 1) % 100).padStart(2, "0");
  }
  const y1 = parseInt(m[1], 10) + 1;
  const y2 = (parseInt(m[2].length === 2 ? "20" + m[2] : m[2], 10) + 1) % 100;
  return y1 + "/" + String(y2).padStart(2, "0");
}

/** Sezon fikstür sayıları (UI + finalize kontrolü) */
async function countFixturesByStatus(seasonId) {
  const { rows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'finished')::int AS finished,
       COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
       COUNT(*) FILTER (WHERE status = 'live')::int AS live,
       COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
       COUNT(*) FILTER (WHERE status IN ('scheduled','live'))::int AS open,
       COUNT(*)::int AS total
     FROM fixtures WHERE season_id = $1`,
    [seasonId],
  );
  const s = rows[0] || {};
  return {
    finished: s.finished || 0,
    scheduled: s.scheduled || 0,
    live: s.live || 0,
    cancelled: s.cancelled || 0,
    open: s.open || 0,
    total: s.total || 0,
  };
}

/** Tüm maçlar bitmiş mi? */
async function isSeasonComplete(seasonId) {
  const counts = await countFixturesByStatus(seasonId);
  if (!counts.total) return false;
  return counts.open === 0;
}

/** seasons satırı (status / champion alanları 022 migration ile gelir) */
async function readSeasonRow(seasonId) {
  try {
    const { rows } = await query(
      `SELECT id, country, division, year_label AS "yearLabel",
              is_current AS "isCurrent",
              status,
              champion_name AS "championName",
              champion_club_id AS "championClubId",
              finished_at AS "finishedAt"
       FROM seasons WHERE id = $1`,
      [seasonId],
    );
    return rows[0] || null;
  } catch (e) {
    // Eski şema (status / champion yok)
    const { rows } = await query(
      `SELECT id, country, division, year_label AS "yearLabel",
              is_current AS "isCurrent"
       FROM seasons WHERE id = $1`,
      [seasonId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...r,
      status: r.isCurrent ? "active" : "finished",
      championName: null,
      championClubId: null,
      finishedAt: null,
    };
  }
}

async function tryFinalizeAfterLeagueMatch(fixtureId) {
  if (!fixtureId) return { ok: false, skipped: true };
  const fixture = await leagueRepo.getFixtureById(fixtureId);
  if (!fixture || !fixture.seasonId) return { ok: false, skipped: true };

  const counts = await countFixturesByStatus(fixture.seasonId);
  if (!counts.total || counts.open > 0) {
    return { ok: true, skipped: true, open: counts.open };
  }
  return finalizeSeason(fixture.seasonId, {});
}

async function finalizeSeason(seasonId, opts = {}) {
  const { rows: seasonRows } = await query(
    `SELECT id, country, division, year_label, is_current
     FROM seasons WHERE id = $1`,
    [seasonId],
  );
  const season = seasonRows[0];
  if (!season) return { ok: false, error: "Sezon yok" };
  if (!season.is_current && !opts.force) {
    return { ok: false, error: "Sezon zaten kapalı", skipped: true };
  }

  const standings = await leagueRepo.getStandings(seasonId);
  if (!standings || !standings.length) {
    return { ok: false, error: "Puan durumu boş" };
  }

  // Sıralama: pts, gd, gf
  const ranked = standings
    .map((r) => ({
      clubId: r.clubId || r.club_id,
      name: r.name || r.clubName || r.club_name,
      pts: Number(r.pts) || 0,
      gd: (Number(r.gf) || 0) - (Number(r.ga) || 0),
      gf: Number(r.gf) || 0,
      played: Number(r.played) || 0,
    }))
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);

  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  const champion = ranked[0] || null;
  const division = Number(season.division) || 1;

  // Nakit ödüller
  for (const row of ranked) {
    const prize = prizeForRank(row.rank, division);
    if (prize > 0 && row.clubId) {
      await clubsRepo.adjustBalance(
        row.clubId,
        prize,
        `Sezon ödülü ${row.rank}. sıra (${season.year_label})`,
      );
    }
  }

  // Gol / asist kralı
  let goalKing = null;
  let assistKing = null;
  try {
    const awards = await statsRepo.computeSeasonAwards(seasonId);
    goalKing = awards && awards.goalKing;
    assistKing = awards && awards.assistKing;
    if (goalKing && goalKing.clubId) {
      await clubsRepo.adjustBalance(goalKing.clubId, 40000, "Gol kralı ödülü");
    }
    if (assistKing && assistKing.clubId) {
      await clubsRepo.adjustBalance(assistKing.clubId, 25000, "Asist kralı ödülü");
    }
    if (champion) {
      await query(
        `INSERT INTO season_awards (season_id, award_type, player_name, club_name, value, meta)
         VALUES ($1, 'league_champion', $2, $2, $3, $4::jsonb)`,
        [
          seasonId,
          champion.name || "Şampiyon",
          prizeForRank(1, division),
          JSON.stringify({ clubId: champion.clubId, rank: 1 }),
        ],
      );
    }
  } catch (e) {
    console.warn("[seasonLifecycle] awards", e.message);
  }

  // Başarılar: şampiyon
  try {
    const ach = require("./achievementsSystem");
    if (champion && champion.clubId) {
      await ach.onLeagueChampion(champion.clubId);
    }
  } catch (_) {}

  // Yükselme / düşme (div 1-3 varsayımı)
  const n = ranked.length;
  const promoteCount = Math.min(2, Math.floor(n / 6) || 1);
  const relegateCount = promoteCount;

  if (division > 1) {
    for (let i = 0; i < promoteCount && i < ranked.length; i++) {
      const c = ranked[i];
      if (c.clubId) {
        await query(
          `UPDATE clubs SET division = $2 WHERE id = $1`,
          [c.clubId, division - 1],
        );
        try {
          await require("./achievementsSystem").onPromotion(c.clubId);
        } catch (_) {}
      }
    }
  }
  if (division < 3) {
    for (let i = 0; i < relegateCount && i < ranked.length; i++) {
      const c = ranked[n - 1 - i];
      if (c.clubId) {
        await query(
          `UPDATE clubs SET division = $2 WHERE id = $1`,
          [c.clubId, division + 1],
        );
      }
    }
  }

  // Sezonu kapat
  await query(`UPDATE seasons SET is_current = FALSE WHERE id = $1`, [
    seasonId,
  ]);

  // Yeni sezon
  const newLabel = nextYearLabel(season.year_label);
  const nextSeason = await leagueRepo.ensureSeason(
    season.country,
    division,
    newLabel,
  );

  // Bu ligdeki kulüpleri standings'e ekle
  const { rows: clubRows } = await query(
    `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
    [season.country, division],
  );
  for (const c of clubRows) {
    await leagueRepo.ensureClubInStandings(nextSeason.id, c.id);
  }

  // Fikstür
  try {
    await leagueRepo.generateFixturesForSeason(nextSeason.id, {});
  } catch (e) {
    console.warn("[seasonLifecycle] fixtures", e.message);
  }

  // Yeni sezon: kupa + milli + dostluk (ülke bazlı)
  try {
    const cupRepo = require("./repos/cupRepo");
    const nationalSystem = require("./nationalSystem");
    const comp = require("./competitionBootstrap");
    const yearLabel = nextSeason.yearLabel || comp.currentYearLabel();
    const clubIds = await cupRepo.listClubIdsForCountry(season.country);
    if (clubIds && clubIds.length >= 2) {
      try {
        let cupStart = new Date(Date.now() + 45 * 60 * 1000);
        try {
          const seasonConfig = require("./seasonConfig");
          cupStart = await seasonConfig.getSeasonStartAt();
        } catch (_) {}
        await cupRepo.createEdition(season.country, yearLabel, clubIds, {
          startAt: cupStart,
        });
      } catch (eCup) {
        console.warn("[seasonLifecycle] cup", eCup.message);
      }
    }
    try {
      await nationalSystem.ensureAllNationalFixtures(season.country);
    } catch (eNat) {
      console.warn("[seasonLifecycle] national", eNat.message);
    }

    // 1. Lig kapanınca: yeterli ülke bittiyse Kıtasal Lig + Elite Kupa (2. sezon)
    if (division === 1) {
      try {
        const gate = require("./continentalGate");
        const r = await gate.tryStartSeason2Competitions({
          yearLabel: yearLabel,
        });
        if (r && r.started) {
          console.log(
            "[seasonLifecycle] Kıtasal Lig / Elite Kupa",
            r.continental && (r.continental.ok || r.continental.status),
            r.eliteCup && (r.eliteCup.ok || r.eliteCup.status),
          );
        }
      } catch (eCL) {
        console.warn("[seasonLifecycle] continentalGate", eCL.message);
      }
    }
    try {
      await comp.scheduleWeeklyFriendlies({ maxPairsPerCountry: 12 });
    } catch (eFr) {
      console.warn("[seasonLifecycle] friendly", eFr.message);
    }
  } catch (eComp) {
    console.warn("[seasonLifecycle] competitions", eComp.message);
  }

  // Youth draws reset
  try {
    await query(
      `UPDATE youth_academy ya SET draws_this_season = 0, home_draws_this_season = 0
       FROM clubs c WHERE c.id = ya.club_id AND c.country = $1 AND c.division = $2`,
      [season.country, division],
    );
  } catch (_) {
    try {
      await query(
        `UPDATE youth_academy ya SET draws_this_season = 0
         FROM clubs c WHERE c.id = ya.club_id AND c.country = $1 AND c.division = $2`,
        [season.country, division],
      );
    } catch (__) {}
  }

  // Bildirimler
  try {
    for (const row of ranked.slice(0, 5)) {
      if (!row.clubId) continue;
      const club = await clubsRepo.getClub(row.clubId);
      if (club && club.user_id && !club.is_bot) {
        const msg =
          row.rank === 1
            ? `🏆 ${season.year_label} şampiyonu oldun!`
            : `Sezon bitti · Sıralama: ${row.rank}.`;
        await socialSystem.pushNotification(club.user_id, "🏆", msg, "sezon");
      }
    }
  } catch (_) {}

  return {
    ok: true,
    skipped: false,
    seasonId,
    country: season.country,
    division,
    yearLabel: season.year_label,
    champion: champion
      ? { id: champion.clubId, name: champion.name, pts: champion.pts }
      : null,
    standings: ranked,
    goalKing,
    assistKing,
    nextSeason,
  };
}

module.exports = {
  tryFinalizeAfterLeagueMatch,
  finalizeSeason,
  prizeForRank,
  nextYearLabel,
  countFixturesByStatus,
  isSeasonComplete,
  readSeasonRow,
};
