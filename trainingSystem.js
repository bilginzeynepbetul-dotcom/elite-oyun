// ============================================================
// trainingSystem.js — bireysel / kadro antrenmanı
// ============================================================

const clubsRepo = require("./repos/clubsRepo");
const trainingRepo = require("./repos/trainingRepo");
const staffSystem = require("./staffSystem");
const { query } = require("./db");

const TRAINABLE = [
  "pace",
  "passing",
  "finishing",
  "tackle",
  "vision",
  "stamina",
  "strength",
  "technique",
  "agility",
  "positioning",
  "reflex",
  "handling",
];

async function getState(clubId) {
  const base = await trainingRepo.getTrainingState(clubId);
  const team = await clubsRepo.getTeam(clubId);
  const players = [
    ...((team && team.players) || []),
    ...((team && team.bench) || []),
  ];
  let sum = 0;
  let low = 0;
  let n = 0;
  for (const p of players) {
    if (!p) continue;
    const c = Number(p.condition) || 0;
    sum += c;
    n++;
    if (c < 70) low++;
  }
  return {
    ...base,
    conditionSummary: {
      avg: n ? Math.round(sum / n) : 0,
      low,
      count: n,
    },
  };
}

function coachBonus(coaches, skill) {
  const c = (coaches || []).find((x) => x.skill === skill);
  if (!c) return 0;
  return 0.15 * (Number(c.level) || 1);
}

async function trainPlayer(clubId, playerId, skill) {
  const sk = String(skill || "").toLowerCase();
  if (!TRAINABLE.includes(sk)) {
    return { ok: false, error: "Geçersiz skill" };
  }
  const team = await clubsRepo.getTeam(clubId);
  if (!team) return { ok: false, error: "Kulüp yok" };
  const all = [...(team.players || []), ...(team.bench || [])];
  const player = all.find((p) => p && String(p.id) === String(playerId));
  if (!player) return { ok: false, error: "Oyuncu yok" };
  if (player.injured) return { ok: false, error: "Sakat oyuncu antrenman yapamaz" };

  const coaches = await staffSystem.listCoaches(clubId);
  const cond = Number(player.condition) || 80;
  if (cond < 40) return { ok: false, error: "Kondisyon çok düşük" };

  const base = 0.15 + Math.random() * 0.35;
  const bonus = coachBonus(coaches, sk);
  const condFactor = cond >= 80 ? 1.1 : cond >= 60 ? 1.0 : 0.75;
  let delta = Math.round((base + bonus) * condFactor * 100) / 100;
  const cur = Number(player[sk]) || 10;
  const next = Math.min(20, Math.round((cur + delta) * 10) / 10);
  delta = Math.round((next - cur) * 100) / 100;

  player[sk] = next;
  player.condition = Math.max(20, cond - (2 + Math.floor(Math.random() * 3)));

  // DB güncelle
  await query(
    `UPDATE players SET ${sk} = $2, condition = $3 WHERE id = $1 AND club_id = $4`,
    [player.id, next, player.condition, clubId],
  );
  await trainingRepo.logTraining(clubId, {
    playerId: player.id,
    name: player.name,
    skill: sk,
    delta,
    to: next,
  });

  const state = await getState(clubId);
  try {
    const { rows } = await query(`SELECT user_id FROM clubs WHERE id = $1`, [clubId]);
    const uid = rows[0] && rows[0].user_id;
    if (uid) {
      try { await require("./dailyChallengeSystem").onTrain(uid); } catch (_) {}
    }
  } catch (_) {}
  return {
    ok: true,
    state,
    result: { name: player.name, skill: sk, delta, to: next },
  };
}

async function trainSquad(clubId, focusSkill) {
  const team = await clubsRepo.getTeam(clubId);
  if (!team) return { ok: false, error: "Kulüp yok" };
  const coaches = await staffSystem.listCoaches(clubId);
  let focus = focusSkill;
  if (!focus && coaches.length) {
    coaches.sort((a, b) => (b.level || 0) - (a.level || 0));
    focus = coaches[0].skill;
  }
  focus = focus || TRAINABLE[Math.floor(Math.random() * 6)];

  const results = [];
  const all = [...(team.players || []), ...(team.bench || [])];
  for (const p of all) {
    if (!p || !p.id || p.injured) continue;
    const sk = focus;
    if (!TRAINABLE.includes(sk)) continue;
    const cond = Number(p.condition) || 80;
    if (cond < 35) continue;
    const base = 0.08 + Math.random() * 0.2;
    const bonus = coachBonus(coaches, sk) * 0.7;
    let delta = Math.round((base + bonus) * 100) / 100;
    const cur = Number(p[sk]) || 10;
    const next = Math.min(20, Math.round((cur + delta) * 10) / 10);
    delta = Math.round((next - cur) * 100) / 100;
    p[sk] = next;
    // Manuel antrenman yorgunluk
    p.condition = Math.max(20, cond - (2 + Math.floor(Math.random() * 3)));
    await query(
      `UPDATE players SET ${sk} = $2, condition = $3 WHERE id = $1 AND club_id = $4`,
      [p.id, next, p.condition, clubId],
    );
    await trainingRepo.logTraining(clubId, {
      playerId: p.id,
      name: p.name,
      skill: sk,
      delta,
      to: next,
    });
    results.push({ name: p.name, skill: sk, delta, to: next });
  }

  const state = await getState(clubId);
  try {
    const { rows } = await query(`SELECT user_id FROM clubs WHERE id = $1`, [clubId]);
    const uid = rows[0] && rows[0].user_id;
    if (uid) {
      try { await require("./dailyChallengeSystem").onTrain(uid); } catch (_) {}
    }
  } catch (_) {}
  return { ok: true, state, results, focus };
}

/** Auto-train varyantı: skill artışı + condition toparlanma */
async function trainSquadAuto(clubId, focusSkill) {
  const r = await trainSquad(clubId, focusSkill);
  if (!r.ok) return r;
  // Auto: condition +4
  await query(
    `UPDATE players SET condition = LEAST(100, condition + 4)
     WHERE club_id = $1 AND COALESCE(injured, FALSE) = FALSE`,
    [clubId],
  );
  r.state = await getState(clubId);
  return r;
}

async function restRecovery(clubId) {
  await query(
    `UPDATE players SET condition = LEAST(100, condition + 3)
     WHERE club_id = $1 AND condition < 92 AND COALESCE(injured, FALSE) = FALSE`,
    [clubId],
  );
  return { ok: true };
}

module.exports = {
  getState,
  trainPlayer,
  trainSquad,
  trainSquadAuto,
  restRecovery,
  TRAINABLE,
};
