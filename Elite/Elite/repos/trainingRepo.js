const { query } = require("../db");

async function getTrainingState(clubId) {
  const { rows: coaches } = await query(
    `SELECT id, skill, level, salary, name FROM club_coaches WHERE club_id = $1`,
    [clubId],
  );
  const { rows: recent } = await query(
    `SELECT player_name AS name, skill, delta, value_after AS "to", created_at AS at
     FROM training_log WHERE club_id = $1
     ORDER BY created_at DESC LIMIT 15`,
    [clubId],
  );
  return {
    coaches: coaches.map((c) => ({
      id: c.id,
      skill: c.skill,
      level: c.level,
      salary: c.salary,
      name: c.name,
      skillLabel: c.name,
    })),
    recent: recent.map((r) => ({
      name: r.name,
      skill: r.skill,
      delta: r.delta,
      to: r.to,
      at: r.at ? new Date(r.at).getTime() : Date.now(),
    })),
  };
}

async function saveTrainingState(clubId, s) {
  // coaches: replace set
  const coaches = s.coaches || [];
  await query(`DELETE FROM club_coaches WHERE club_id = $1`, [clubId]);
  for (const c of coaches) {
    await query(
      `INSERT INTO club_coaches (club_id, skill, level, salary, name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (club_id, skill) DO UPDATE SET
         level = EXCLUDED.level, salary = EXCLUDED.salary, name = EXCLUDED.name`,
      [clubId, c.skill, c.level || 1, c.salary || 0, c.name || c.skillLabel || c.skill],
    );
  }
}

async function logTraining(clubId, result) {
  if (!result) return;
  await query(
    `INSERT INTO training_log (club_id, player_id, player_name, skill, delta, value_after)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      clubId,
      result.playerId || null,
      result.name || null,
      result.skill,
      result.delta,
      result.to,
    ],
  );
}

module.exports = { getTrainingState, saveTrainingState, logTraining };
