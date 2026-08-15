// ============================================================
// repos/statsRepo.js — sezon gol/asist + ayın/yılın oyuncusu
// ============================================================

const { query } = require("../db");

async function addPlayerMatchContribution(opts) {
  const {
    seasonId,
    playerId,
    clubId,
    playerName,
    clubName,
    goals,
    assists,
    isMotm,
  } = opts;
  if (!seasonId || !playerId) return;

  const g = Number(goals) || 0;
  const a = Number(assists) || 0;
  const motm = isMotm ? 1 : 0;

  await query(
    `INSERT INTO player_season_stats
       (season_id, player_id, club_id, player_name, club_name, goals, assists, matches, motm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8)
     ON CONFLICT (season_id, player_id) DO UPDATE SET
       goals = player_season_stats.goals + EXCLUDED.goals,
       assists = player_season_stats.assists + EXCLUDED.assists,
       matches = player_season_stats.matches + 1,
       motm = player_season_stats.motm + EXCLUDED.motm,
       player_name = EXCLUDED.player_name,
       club_name = COALESCE(EXCLUDED.club_name, player_season_stats.club_name),
       club_id = COALESCE(EXCLUDED.club_id, player_season_stats.club_id)`,
    [
      seasonId,
      playerId,
      clubId || null,
      playerName || "?",
      clubName || null,
      g,
      a,
      motm,
    ],
  );

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  await query(
    `INSERT INTO player_month_stats
       (year, month, player_id, club_id, player_name, club_name, goals, assists, matches)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
     ON CONFLICT (year, month, player_id) DO UPDATE SET
       goals = player_month_stats.goals + EXCLUDED.goals,
       assists = player_month_stats.assists + EXCLUDED.assists,
       matches = player_month_stats.matches + 1,
       player_name = EXCLUDED.player_name,
       club_name = COALESCE(EXCLUDED.club_name, player_month_stats.club_name)`,
    [year, month, playerId, clubId || null, playerName || "?", clubName || null, g, a],
  );

  // Kariyer sayacı (players tablosu)
  if (g || a) {
    await query(
      `UPDATE players SET
         goals = COALESCE(goals, 0) + $2,
         assists = COALESCE(assists, 0) + $3
       WHERE id = $1`,
      [playerId, g, a],
    );
  }
}

async function topSeason(seasonId, kind, limit) {
  limit = Math.min(50, Math.max(1, limit || 20));
  const order =
    kind === "assists"
      ? "assists DESC, goals DESC"
      : kind === "motm"
        ? "motm DESC, goals DESC"
        : "goals DESC, assists DESC";
  const { rows } = await query(
    `SELECT player_id AS "playerId", player_name AS "playerName",
            club_name AS "clubName", club_id AS "clubId",
            goals, assists, matches, motm
     FROM player_season_stats
     WHERE season_id = $1
     ORDER BY ${order}
     LIMIT $2`,
    [seasonId, limit],
  );
  return rows;
}

async function topMonth(year, month, kind, limit) {
  limit = Math.min(50, Math.max(1, limit || 20));
  const order =
    kind === "assists"
      ? "assists DESC, goals DESC"
      : "goals DESC, assists DESC";
  const { rows } = await query(
    `SELECT player_id AS "playerId", player_name AS "playerName",
            club_name AS "clubName", club_id AS "clubId",
            goals, assists, matches
     FROM player_month_stats
     WHERE year = $1 AND month = $2
     ORDER BY ${order}
     LIMIT $3`,
    [year, month, limit],
  );
  return rows;
}

/** Skor: gol*3 + asist*2 + motm*1 */
function scoreRow(r) {
  return (Number(r.goals) || 0) * 3 + (Number(r.assists) || 0) * 2 + (Number(r.motm) || 0);
}

async function computePlayerOfMonth(year, month) {
  const rows = await topMonth(year, month, "goals", 50);
  if (!rows.length) return null;
  rows.sort((a, b) => {
    const sa =
      (Number(a.goals) || 0) * 3 + (Number(a.assists) || 0) * 2;
    const sb =
      (Number(b.goals) || 0) * 3 + (Number(b.assists) || 0) * 2;
    return sb - sa;
  });
  const best = rows[0];
  const value =
    (Number(best.goals) || 0) * 3 + (Number(best.assists) || 0) * 2;
  await query(
    `INSERT INTO season_awards
       (award_type, year, month, player_id, player_name, club_name, value, meta)
     VALUES ('player_of_month', $1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      year,
      month,
      best.playerId,
      best.playerName,
      best.clubName,
      value,
      JSON.stringify({ goals: best.goals, assists: best.assists }),
    ],
  );
  return best;
}

async function computeSeasonAwards(seasonId) {
  const goals = await topSeason(seasonId, "goals", 1);
  const assists = await topSeason(seasonId, "assists", 1);
  const all = await topSeason(seasonId, "goals", 80);
  all.sort((a, b) => scoreRow(b) - scoreRow(a));
  const poty = all[0] || null;

  const out = {};
  if (goals[0]) {
    await query(
      `INSERT INTO season_awards
         (season_id, award_type, player_id, player_name, club_name, value, meta)
       VALUES ($1, 'goal_king', $2, $3, $4, $5, $6::jsonb)`,
      [
        seasonId,
        goals[0].playerId,
        goals[0].playerName,
        goals[0].clubName,
        goals[0].goals,
        JSON.stringify({ assists: goals[0].assists }),
      ],
    );
    out.goalKing = goals[0];
  }
  if (assists[0]) {
    await query(
      `INSERT INTO season_awards
         (season_id, award_type, player_id, player_name, club_name, value, meta)
       VALUES ($1, 'assist_king', $2, $3, $4, $5, $6::jsonb)`,
      [
        seasonId,
        assists[0].playerId,
        assists[0].playerName,
        assists[0].clubName,
        assists[0].assists,
        JSON.stringify({ goals: assists[0].goals }),
      ],
    );
    out.assistKing = assists[0];
  }
  if (poty) {
    await query(
      `INSERT INTO season_awards
         (season_id, award_type, player_id, player_name, club_name, value, meta)
       VALUES ($1, 'player_of_year', $2, $3, $4, $5, $6::jsonb)`,
      [
        seasonId,
        poty.playerId,
        poty.playerName,
        poty.clubName,
        scoreRow(poty),
        JSON.stringify({
          goals: poty.goals,
          assists: poty.assists,
          motm: poty.motm,
        }),
      ],
    );
    out.playerOfYear = poty;
  }
  return out;
}

async function listAwards(opts = {}) {
  const params = [];
  let sql = `
    SELECT id, season_id AS "seasonId", award_type AS "awardType",
           year, month, player_id AS "playerId", player_name AS "playerName",
           club_name AS "clubName", value, meta, created_at AS "createdAt"
    FROM season_awards WHERE 1=1`;
  if (opts.awardType) {
    params.push(opts.awardType);
    sql += ` AND award_type = $${params.length}`;
  }
  if (opts.seasonId) {
    params.push(opts.seasonId);
    sql += ` AND season_id = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 40`;
  const { rows } = await query(sql, params);
  return rows;
}

module.exports = {
  addPlayerMatchContribution,
  topSeason,
  topMonth,
  computePlayerOfMonth,
  computeSeasonAwards,
  listAwards,
  scoreRow,
};
