// ============================================================
// playerFormSystem.js — Maç sonrası form / kondisyon kalıcılığı (P1 #11)
// ------------------------------------------------------------
// Maç bitince oyuncu condition + form DB'ye yazılır.
// Form: -5..+5  |  Condition: 28..100
// ============================================================

const { query } = require("./db");

function clampForm(v) {
  return Math.max(-5, Math.min(5, Math.round(Number(v) || 0)));
}

function clampCond(v) {
  return Math.max(28, Math.min(100, Math.round(Number(v) || 90)));
}

/**
 * Maç state'inden taraf oyuncularını topla.
 */
function extractSidePlayers(state, matchInstance, side) {
  const list = [];
  try {
    const team =
      (matchInstance && matchInstance[side]) ||
      (state && state[side]) ||
      (state && state.teams && state.teams[side]) ||
      null;
    const starters =
      (team && (team.players || team.xi || team.lineup)) ||
      (state && state[side + "Players"]) ||
      [];
    const bench = (team && team.bench) || [];
    starters.forEach((p) => {
      if (p) list.push({ p, played: true });
    });
    bench.forEach((p) => {
      if (p) list.push({ p, played: !!p._minutes || !!p.minutesPlayed });
    });
  } catch (_) {}
  return list;
}

/**
 * Form delta: sonuç + bireysel katkı.
 * @returns {number} -2..+2 civarı
 */
function formDeltaForPlayer(p, teamResult, played) {
  if (!played) {
    // Oynamayan: hafif nötr / küçük düşüş
    return teamResult === "win" ? 0 : -0.2;
  }
  let d = 0;
  if (teamResult === "win") d += 0.8;
  else if (teamResult === "draw") d += 0.15;
  else d -= 0.7;

  const goals = Number(p.goals) || Number(p.matchGoals) || 0;
  const assists = Number(p.assists) || Number(p.matchAssists) || 0;
  d += Math.min(1.5, goals * 0.45 + assists * 0.3);

  // Kötü condition ile biten ekstra yorgunluk formu biraz kırar
  const cond = Number(p.condition);
  if (Number.isFinite(cond) && cond < 45) d -= 0.25;

  return d;
}

/**
 * Tek oyuncu satırını güncelle (id varsa).
 */
async function persistPlayer(p, formDelta, forceCondition) {
  const id = p.id || p.playerId;
  if (!id) return false;

  // UUID veya numeric/string id — players.id tipine göre
  const newForm = clampForm((Number(p.form) || 0) + formDelta);
  let newCond;
  if (forceCondition != null) {
    newCond = clampCond(forceCondition);
  } else if (p.condition != null) {
    newCond = clampCond(p.condition);
  } else {
    newCond = null;
  }

  try {
    if (newCond != null) {
      await query(
        `UPDATE players SET
           form = $2,
           condition = $3
         WHERE id = $1`,
        [id, newForm, newCond],
      );
    } else {
      await query(
        `UPDATE players SET form = $2 WHERE id = $1`,
        [id, newForm],
      );
    }
    p.form = newForm;
    if (newCond != null) p.condition = newCond;
    return true;
  } catch (e) {
    // id tipi uyuşmazsa sessiz
    return false;
  }
}

/**
 * Ana giriş — matchLifecycle / cupLifecycle vb.
 * @param {object} state match state
 * @param {object} matchInstance Match
 * @param {object} opts { homeClubId, awayClubId }
 */
async function applyPostMatchForm(state, matchInstance, opts) {
  opts = opts || {};
  const score = (state && state.score) || {};
  const hg =
    score.home != null
      ? Number(score.home)
      : Number(state && state.homeGoals) || 0;
  const ag =
    score.away != null
      ? Number(score.away)
      : Number(state && state.awayGoals) || 0;

  const homeResult = hg > ag ? "win" : hg < ag ? "loss" : "draw";
  const awayResult = ag > hg ? "win" : ag < hg ? "loss" : "draw";

  let updated = 0;

  for (const side of ["home", "away"]) {
    const result = side === "home" ? homeResult : awayResult;
    const players = extractSidePlayers(state, matchInstance, side);
    for (const { p, played } of players) {
      const delta = formDeltaForPlayer(p, result, played);
      // Oynayanlar: maç sonu condition yaz; oynamayanlar: hafif toparlanma
      let condWrite = null;
      if (played && p.condition != null) {
        condWrite = p.condition;
      } else if (!played && p.condition != null) {
        condWrite = Math.min(100, (Number(p.condition) || 90) + 3);
      }
      const ok = await persistPlayer(p, delta, condWrite);
      if (ok) updated++;
    }
  }

  // Kadroda olup maçta olmayanlar için kulüp bazlı hafif recovery
  // (opsiyonel — sadece clubId verilmişse)
  for (const clubId of [opts.homeClubId, opts.awayClubId].filter(Boolean)) {
    try {
      await query(
        `UPDATE players SET
           condition = LEAST(100, COALESCE(condition, 90) + 2)
         WHERE club_id = $1
           AND COALESCE(condition, 90) < 88`,
        [clubId],
      );
    } catch (_) {}
  }

  return { updated, homeResult, awayResult };
}

/**
 * Antrenman sonrası form/condition (trainingSystem hook).
 */
async function applyTrainingBoost(playerId, skillGain) {
  if (!playerId) return;
  const formGain = skillGain && skillGain > 0 ? 0.3 : 0.1;
  try {
    await query(
      `UPDATE players SET
         form = GREATEST(-5, LEAST(5, COALESCE(form, 0) + $2)),
         condition = LEAST(100, COALESCE(condition, 90) + 1)
       WHERE id = $1`,
      [playerId, formGain],
    );
  } catch (_) {}
}

module.exports = {
  applyPostMatchForm,
  applyTrainingBoost,
  clampForm,
  clampCond,
  formDeltaForPlayer,
};
