// ============================================================
// repos/leagueRepo.js — seasons, standings, fixtures
// ============================================================

const { query, withTransaction } = require("../db");

async function getCurrentSeason(country = "Türkiye", division = 1) {
  const { rows } = await query(
    `SELECT id, country, division, year_label, is_current
     FROM seasons
     WHERE country = $1 AND division = $2 AND is_current = TRUE
     ORDER BY id DESC LIMIT 1`,
    [country, division],
  );
  return rows[0] || null;
}

async function getStandings(seasonId) {
  const { rows } = await query(
    `SELECT ls.club_id AS "clubId",
            c.name,
            c.user_id AS "userId",
            ls.played, ls.won AS w, ls.drawn AS d, ls.lost AS l,
            ls.gf, ls.ga, ls.pts,
            (ls.gf - ls.ga) AS gd
     FROM league_standings ls
     JOIN clubs c ON c.id = ls.club_id
     WHERE ls.season_id = $1
     ORDER BY ls.pts DESC, (ls.gf - ls.ga) DESC, ls.gf DESC, c.name ASC`,
    [seasonId],
  );
  return rows;
}

async function ensureClubInStandings(seasonId, clubId) {
  await query(
    `INSERT INTO league_standings (season_id, club_id)
     VALUES ($1, $2)
     ON CONFLICT (season_id, club_id) DO NOTHING`,
    [seasonId, clubId],
  );
}

/**
 * Round-robin (single or double) fixture generator.
 * clubs: UUID[]
 * startAt: Date — first kickoff
 * intervalHours: hours between match slots
 * doubleRound: if true, home+away
 */
function generateRoundRobin(clubIds, opts = {}) {
  const doubleRound = opts.doubleRound !== false;
  // intervalMinutes öncelikli; yoksa intervalHours (varsayılan 3 saat)
  const intervalMs = opts.intervalMinutes != null
    ? Number(opts.intervalMinutes) * 60 * 1000
    : (opts.intervalHours != null ? Number(opts.intervalHours) : 3) * 3600 * 1000;
  let startAt;
  if (opts.startAt) {
    startAt = new Date(opts.startAt);
  } else {
    // İlk maç ~2 dk sonra (kullanıcı başlatmaz; scheduler alır)
    startAt = new Date(Date.now() + 2 * 60 * 1000);
  }
  // Takvim modunda geçmiş/gelecek kickoff'lara dokunma (calendar ezebilir)
  if (opts.bumpPast === true && startAt.getTime() < Date.now()) {
    startAt = new Date(Date.now() + 60 * 1000);
  }

  const ids = clubIds.slice();
  // Odd number → bye pad
  const bye = ids.length % 2 === 1;
  if (bye) ids.push(null);

  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const fixtures = [];

  // Circle method
  let arr = ids.slice();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home && away) {
        const kickoff = new Date(
          startAt.getTime() + fixtures.length * intervalMs,
        );
        fixtures.push({
          homeClubId: home,
          awayClubId: away,
          kickoffAt: kickoff,
        });
      }
    }
    // rotate: fix arr[0], rotate rest
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }

  if (doubleRound) {
    const second = fixtures.map((f) => ({
      homeClubId: f.awayClubId,
      awayClubId: f.homeClubId,
      kickoffAt: new Date(
        f.kickoffAt.getTime() + fixtures.length * intervalMs,
      ),
    }));
    const base = startAt.getTime() + fixtures.length * intervalMs;
    second.forEach((f, i) => {
      f.kickoffAt = new Date(base + i * intervalMs);
    });
    return fixtures.concat(second);
  }
  return fixtures;
}

async function listClubIdsInSeason(seasonId) {
  const { rows } = await query(
    `SELECT club_id FROM league_standings WHERE season_id = $1`,
    [seasonId],
  );
  return rows.map((r) => r.club_id);
}

async function listClubIdsByCountryDivision(country, division) {
  const { rows } = await query(
    `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
    [country, division],
  );
  return rows.map((r) => r.id);
}

/**
 * Generate and insert fixtures for a season.
 * Returns { created, skipped }
 */
async function generateFixturesForSeason(seasonId, opts = {}) {
  return withTransaction(async (client) => {
    // Already has fixtures?
    if (!opts.force) {
      const { rows: existing } = await client.query(
        `SELECT COUNT(*)::int AS c FROM fixtures WHERE season_id = $1`,
        [seasonId],
      );
      if (existing[0].c > 0) {
        return { created: 0, skipped: true, reason: "Fikstür zaten var" };
      }
    } else {
      await client.query(
        `DELETE FROM fixtures WHERE season_id = $1 AND status = 'scheduled'`,
        [seasonId],
      );
    }

    const { rows: seasonRows } = await client.query(
      `SELECT country, division FROM seasons WHERE id = $1`,
      [seasonId],
    );
    if (!seasonRows[0]) throw new Error("Sezon yok");

    // Prefer clubs already in standings; else all clubs in country/div
    let { rows: standingClubs } = await client.query(
      `SELECT club_id FROM league_standings WHERE season_id = $1`,
      [seasonId],
    );
    let clubIds = standingClubs.map((r) => r.club_id);

    if (clubIds.length < 2) {
      const { rows: clubs } = await client.query(
        `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
        [seasonRows[0].country, seasonRows[0].division],
      );
      clubIds = clubs.map((r) => r.id);
      for (const id of clubIds) {
        await client.query(
          `INSERT INTO league_standings (season_id, club_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [seasonId, id],
        );
      }
    }

    if (clubIds.length < 2) {
      return { created: 0, skipped: true, reason: "En az 2 kulüp gerekli" };
    }

    // --- Gerçek takvim slotları (3 saat kuralı iptal) ---
    let startAt = opts.startAt;
    let slots = opts.slots;
    try {
      const seasonConfig = require("./seasonConfig");
      if (startAt == null) startAt = await seasonConfig.getSeasonStartAt();
      if (slots == null && seasonConfig.getLeagueMatchSlots) {
        slots = await seasonConfig.getLeagueMatchSlots();
      }
    } catch (_) {}
    if (!startAt) startAt = new Date();

    const rawPairs = generateRoundRobin(clubIds, {
      doubleRound: opts.doubleRound !== false,
      intervalHours: 1,
      startAt: startAt,
      bumpPast: false,
    }).map((f) => ({
      homeClubId: f.homeClubId,
      awayClubId: f.awayClubId,
    }));

    let pairs;
    try {
      const cal = require("./calendarSchedule");
      pairs = cal.assignKickoffsToFixtures(
        rawPairs,
        new Date(startAt),
        slots || cal.DEFAULT_SLOTS,
      );
    } catch (e) {
      console.warn("[leagueRepo] calendar fallback", e.message);
      pairs = generateRoundRobin(clubIds, {
        doubleRound: opts.doubleRound !== false,
        intervalHours: 72,
        startAt: startAt,
        bumpPast: false,
      });
    }

    let created = 0;
    for (const f of pairs) {
      await client.query(
        `INSERT INTO fixtures (season_id, home_club_id, away_club_id, kickoff_at, status)
         VALUES ($1, $2, $3, $4, 'scheduled')`,
        [seasonId, f.homeClubId, f.awayClubId, f.kickoffAt.toISOString()],
      );
      created++;
    }
    return { created, skipped: false };
  });
}

async function listFixtures(seasonId, opts = {}) {
  const params = [seasonId];
  let sql = `
    SELECT f.id, f.season_id AS "seasonId",
           f.home_club_id AS "homeClubId", f.away_club_id AS "awayClubId",
           hc.name AS "homeName", ac.name AS "awayName",
           f.kickoff_at AS "kickoffAt", f.status,
           f.home_goals AS "homeGoals", f.away_goals AS "awayGoals"
    FROM fixtures f
    JOIN clubs hc ON hc.id = f.home_club_id
    JOIN clubs ac ON ac.id = f.away_club_id
    WHERE f.season_id = $1`;
  if (opts.status) {
    params.push(opts.status);
    sql += ` AND f.status = $${params.length}`;
  }
  if (opts.clubId) {
    params.push(opts.clubId);
    sql += ` AND (f.home_club_id = $${params.length} OR f.away_club_id = $${params.length})`;
  }
  sql += ` ORDER BY f.kickoff_at ASC`;
  if (opts.limit) {
    params.push(Number(opts.limit));
    sql += ` LIMIT $${params.length}`;
  }
  const { rows } = await query(sql, params);
  return rows;
}

async function getNextFixtureForClub(clubId) {
  const { rows } = await query(
    `SELECT f.id, f.season_id AS "seasonId",
            f.home_club_id AS "homeClubId", f.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            f.kickoff_at AS "kickoffAt", f.status,
            f.home_goals AS "homeGoals", f.away_goals AS "awayGoals"
     FROM fixtures f
     JOIN clubs hc ON hc.id = f.home_club_id
     JOIN clubs ac ON ac.id = f.away_club_id
     WHERE (f.home_club_id = $1 OR f.away_club_id = $1)
       AND f.status IN ('scheduled', 'live')
     ORDER BY
       CASE WHEN f.status = 'live' THEN 0 ELSE 1 END,
       f.kickoff_at ASC
     LIMIT 1`,
    [clubId],
  );
  return rows[0] || null;
}

async function getFixtureById(fixtureId) {
  const { rows } = await query(
    `SELECT f.id, f.season_id AS "seasonId",
            f.home_club_id AS "homeClubId", f.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            f.kickoff_at AS "kickoffAt", f.status,
            f.home_goals AS "homeGoals", f.away_goals AS "awayGoals",
            f.match_id AS "matchId"
     FROM fixtures f
     JOIN clubs hc ON hc.id = f.home_club_id
     JOIN clubs ac ON ac.id = f.away_club_id
     WHERE f.id = $1`,
    [fixtureId],
  );
  return rows[0] || null;
}

/**
 * Apply finished match to standings + fixture row.
 */
async function applyMatchResult(fixtureId, homeGoals, awayGoals, matchId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM fixtures WHERE id = $1 FOR UPDATE`,
      [fixtureId],
    );
    const f = rows[0];
    if (!f) return { ok: false, error: "Fikstür yok" };
    if (f.status === "finished") return { ok: false, error: "Zaten bitmiş" };

    await client.query(
      `UPDATE fixtures SET status = 'finished', home_goals = $2, away_goals = $3,
         match_id = COALESCE($4, match_id)
       WHERE id = $1`,
      [fixtureId, homeGoals, awayGoals, matchId || null],
    );

    const hg = Number(homeGoals);
    const ag = Number(awayGoals);
    const homePts = hg > ag ? 3 : hg === ag ? 1 : 0;
    const awayPts = ag > hg ? 3 : hg === ag ? 1 : 0;

    await client.query(
      `UPDATE league_standings SET
         played = played + 1,
         won = won + CASE WHEN $3 > $4 THEN 1 ELSE 0 END,
         drawn = drawn + CASE WHEN $3 = $4 THEN 1 ELSE 0 END,
         lost = lost + CASE WHEN $3 < $4 THEN 1 ELSE 0 END,
         gf = gf + $3, ga = ga + $4, pts = pts + $5
       WHERE season_id = $1 AND club_id = $2`,
      [f.season_id, f.home_club_id, hg, ag, homePts],
    );
    await client.query(
      `UPDATE league_standings SET
         played = played + 1,
         won = won + CASE WHEN $4 > $3 THEN 1 ELSE 0 END,
         drawn = drawn + CASE WHEN $3 = $4 THEN 1 ELSE 0 END,
         lost = lost + CASE WHEN $4 < $3 THEN 1 ELSE 0 END,
         gf = gf + $4, ga = ga + $3, pts = pts + $5
       WHERE season_id = $1 AND club_id = $2`,
      [f.season_id, f.away_club_id, hg, ag, awayPts],
    );

    await client.query(
      `INSERT INTO match_results (fixture_id, home_club_id, away_club_id, home_goals, away_goals)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fixture_id) DO UPDATE SET
         home_goals = EXCLUDED.home_goals, away_goals = EXCLUDED.away_goals`,
      [fixtureId, f.home_club_id, f.away_club_id, hg, ag],
    );

    return {
      ok: true,
      homeClubId: f.home_club_id,
      awayClubId: f.away_club_id,
      homeGoals: hg,
      awayGoals: ag,
    };
  });
}

async function setFixtureLive(fixtureId, matchId) {
  await query(
    `UPDATE fixtures SET status = 'live', match_id = COALESCE($2, match_id)
     WHERE id = $1 AND status = 'scheduled'`,
    [fixtureId, matchId || null],
  );
}

module.exports = {
  getCurrentSeason,
  getStandings,
  ensureClubInStandings,
  generateRoundRobin,
  generateFixturesForSeason,
  listFixtures,
  getNextFixtureForClub,
  getFixtureById,
  applyMatchResult,
  setFixtureLive,
  listClubIdsInSeason,
  listClubIdsByCountryDivision,
};
