const { query } = require("../db");

async function getYouthState(clubId) {
  const { rows } = await query(
    `SELECT scout_level, academy_level, draws_this_season, max_draws_per_season,
            last_draw_week_key, scout_upgrade_until, academy_upgrade_until,
            pending_scout_level, pending_academy_level
     FROM youth_academy WHERE club_id = $1`,
    [clubId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  const { rows: recent } = await query(
    `SELECT name, pos, age, created_at AS at FROM youth_discoveries
     WHERE club_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [clubId],
  );
  return {
    scoutLevel: r.scout_level,
    academyLevel: r.academy_level,
    drawsThisSeason: r.draws_this_season,
    maxDrawsPerSeason: r.max_draws_per_season,
    lastDrawWeekKey: r.last_draw_week_key || "",
    scoutUpgradeUntil: r.scout_upgrade_until
      ? new Date(r.scout_upgrade_until).getTime()
      : 0,
    academyUpgradeUntil: r.academy_upgrade_until
      ? new Date(r.academy_upgrade_until).getTime()
      : 0,
    pendingScoutLevel: r.pending_scout_level,
    pendingAcademyLevel: r.pending_academy_level,
    recent: recent.map((x) => ({
      name: x.name,
      pos: x.pos,
      age: x.age,
      at: x.at ? new Date(x.at).getTime() : Date.now(),
    })),
  };
}

async function saveYouthState(clubId, s) {
  await query(
    `INSERT INTO youth_academy (
       club_id, scout_level, academy_level, draws_this_season, max_draws_per_season,
       last_draw_week_key, scout_upgrade_until, academy_upgrade_until,
       pending_scout_level, pending_academy_level
     ) VALUES ($1,$2,$3,$4,$5,$6,
       CASE WHEN $7::bigint > 0 THEN to_timestamp($7::bigint/1000.0) ELSE NULL END,
       CASE WHEN $8::bigint > 0 THEN to_timestamp($8::bigint/1000.0) ELSE NULL END,
       $9,$10)
     ON CONFLICT (club_id) DO UPDATE SET
       scout_level = EXCLUDED.scout_level,
       academy_level = EXCLUDED.academy_level,
       draws_this_season = EXCLUDED.draws_this_season,
       max_draws_per_season = EXCLUDED.max_draws_per_season,
       last_draw_week_key = EXCLUDED.last_draw_week_key,
       scout_upgrade_until = EXCLUDED.scout_upgrade_until,
       academy_upgrade_until = EXCLUDED.academy_upgrade_until,
       pending_scout_level = EXCLUDED.pending_scout_level,
       pending_academy_level = EXCLUDED.pending_academy_level,
       updated_at = NOW()`,
    [
      clubId,
      s.scoutLevel || 1,
      s.academyLevel || 1,
      s.drawsThisSeason || 0,
      s.maxDrawsPerSeason || 12,
      s.lastDrawWeekKey || null,
      s.scoutUpgradeUntil || 0,
      s.academyUpgradeUntil || 0,
      s.pendingScoutLevel || null,
      s.pendingAcademyLevel || null,
    ],
  );
}

async function addDiscovery(clubId, player) {
  await query(
    `INSERT INTO youth_discoveries (club_id, player_id, name, pos, age)
     VALUES ($1, $2, $3, $4, $5)`,
    [clubId, player.id || null, player.name, player.pos, player.age],
  );
}

module.exports = { getYouthState, saveYouthState, addDiscovery };
