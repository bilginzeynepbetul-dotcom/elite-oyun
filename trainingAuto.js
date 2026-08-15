// ============================================================
// trainingAuto.js — haftalık otomatik antrenman (P1 #12)
// ============================================================

const { query } = require("./db");
const seasonConfig = require("./seasonConfig");
const trainingSystem = require("./trainingSystem");
const staffSystem = require("./staffSystem");

function currentWeekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return date.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

async function runWeeklyTrainingAuto() {
  const wk = currentWeekKey();
  const last = await seasonConfig.getSetting("training_auto_week", "");
  if (last === wk) return { ok: true, skipped: true, week: wk };

  const { rows: clubs } = await query(
    `SELECT id FROM clubs
     WHERE user_id IS NOT NULL AND COALESCE(is_bot, FALSE) = FALSE`,
  );

  let trained = 0;
  for (const c of clubs) {
    try {
      const coaches = await staffSystem.listCoaches(c.id);
      let focus = null;
      if (coaches.length) {
        coaches.sort((a, b) => (b.level || 0) - (a.level || 0));
        focus = coaches[0].skill;
      }
      await trainingSystem.trainSquadAuto(c.id, focus);
      trained++;
    } catch (e) {
      console.warn("[trainingAuto]", c.id, e.message);
    }
  }

  await seasonConfig.setSetting("training_auto_week", wk);
  return { ok: true, week: wk, trained };
}

async function runRestRecovery() {
  const { rows: clubs } = await query(
    `SELECT id FROM clubs WHERE user_id IS NOT NULL AND COALESCE(is_bot, FALSE) = FALSE`,
  );
  for (const c of clubs) {
    try {
      await trainingSystem.restRecovery(c.id);
    } catch (_) {}
  }
  return { ok: true, clubs: clubs.length };
}

module.exports = { runWeeklyTrainingAuto, runRestRecovery, currentWeekKey };
