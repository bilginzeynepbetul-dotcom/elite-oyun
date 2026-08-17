// ============================================================
// seasonAutomation.js — periyodik sezon bakımı (P0 #3)
// ============================================================

const { query } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const clubsRepo = require("./repos/clubsRepo");
const statsRepo = require("./repos/statsRepo");
const seasonLifecycle = require("./seasonLifecycle");
const trainingAuto = require("./trainingAuto");

const STUCK_LIVE_HOURS = Number(process.env.STUCK_LIVE_HOURS) || 3;
const OVERDUE_SCHEDULED_HOURS =
  Number(process.env.OVERDUE_SCHEDULED_HOURS) || 2;

async function finalizePlayerOfMonth() {
  const now = new Date();
  // Önceki ay
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based current → previous
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  // m is 1-12 for previous month
  try {
    const key = `pom_done_${y}_${m}`;
    const seasonConfig = require("./seasonConfig");
    const done = await seasonConfig.getSetting(key, null);
    if (done) return { ok: true, skipped: true };

    const pom = await statsRepo.computePlayerOfMonth(y, m);
    if (pom && pom.clubId) {
      await clubsRepo.adjustBalance(pom.clubId, 75000, `Ayın oyuncusu ${m}/${y}`);
      try {
        const club = await clubsRepo.getClub(pom.clubId);
        if (club && club.user_id) {
          const social = require("./socialSystem");
          await social.pushNotification(
            club.user_id,
            "⭐",
            `Ayın oyuncusu: ${pom.playerName || pom.name} · +75.000 €`,
            "ödül",
          );
        }
      } catch (_) {}
    }
    await seasonConfig.setSetting(key, String(Date.now()));
    return { ok: true, pom };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function cleanupStuckLive() {
  const hours = STUCK_LIVE_HOURS;
  const { rows } = await query(
    `SELECT id, home_goals, away_goals, match_id
     FROM fixtures
     WHERE status = 'live'
       AND COALESCE(kickoff_at, created_at) < NOW() - ($1 || ' hours')::interval
     LIMIT 20`,
    [String(hours)],
  );
  let n = 0;
  for (const f of rows) {
    try {
      const hg = f.home_goals != null ? f.home_goals : 0;
      const ag = f.away_goals != null ? f.away_goals : 0;
      await leagueRepo.applyMatchResult(f.id, hg, ag, f.match_id);
      n++;
    } catch (e) {
      console.warn("[seasonAuto] stuck live", f.id, e.message);
    }
  }
  return { ok: true, closed: n };
}

/**
 * Saati gelmiş ama hâlâ scheduled olan maçları hızlı skorla bitirip
 * puan durumuna işler. Canlı motor başlatılamadıysa / insan offline ise
 * ligin ilerlemesi için gerekli.
 * - Bot-bot: kickoff + 1 dk
 * - İnsan içeren: kickoff + 30 dk (oyuncu oynamazsa AI sim)
 */
function randomMatchScore() {
  // 0-4 arası gerçekçi skor dağılımı
  const weights = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 4];
  const a = weights[Math.floor(Math.random() * weights.length)];
  const b = weights[Math.floor(Math.random() * weights.length)];
  return [a, b];
}

async function autoResolveDueMatches() {
  // Önce bot-bot (kickoff geçmiş)
  const { rows: botRows } = await query(
    `SELECT f.id, f.home_club_id, f.away_club_id
     FROM fixtures f
     JOIN clubs h ON h.id = f.home_club_id
     JOIN clubs a ON a.id = f.away_club_id
     WHERE f.status = 'scheduled'
       AND f.kickoff_at <= NOW()
       AND COALESCE(h.is_bot, FALSE) = TRUE
       AND COALESCE(a.is_bot, FALSE) = TRUE
     ORDER BY f.kickoff_at ASC
     LIMIT 40`,
  );
  // İnsan içeren — 30 dk gecikme
  const { rows: humanRows } = await query(
    `SELECT f.id, f.home_club_id, f.away_club_id
     FROM fixtures f
     JOIN clubs h ON h.id = f.home_club_id
     JOIN clubs a ON a.id = f.away_club_id
     WHERE f.status = 'scheduled'
       AND f.kickoff_at <= NOW() - INTERVAL '30 minutes'
       AND (COALESCE(h.is_bot, FALSE) = FALSE OR COALESCE(a.is_bot, FALSE) = FALSE)
     ORDER BY f.kickoff_at ASC
     LIMIT 20`,
  );
  let n = 0;
  const seen = new Set();
  for (const f of botRows.concat(humanRows)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    try {
      if (!f.home_club_id || !f.away_club_id) {
        await query(
          `UPDATE fixtures SET status = 'finished', home_goals = 0, away_goals = 0 WHERE id = $1 AND status = 'scheduled'`,
          [f.id],
        );
        n++;
        continue;
      }
      const [hg, ag] = randomMatchScore();
      const result = await leagueRepo.applyMatchResult(f.id, hg, ag, null);
      if (result && result.ok) {
        n++;
        try {
          const seasonLifecycle = require("./seasonLifecycle");
          if (seasonLifecycle.tryFinalizeAfterLeagueMatch) {
            await seasonLifecycle.tryFinalizeAfterLeagueMatch(f.id);
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn("[seasonAuto] autoResolve", f.id, e.message);
    }
  }
  return { ok: true, resolved: n };
}

async function forfeitOverdue() {
  const hours = OVERDUE_SCHEDULED_HOURS;
  const { rows } = await query(
    `SELECT id, home_club_id, away_club_id
     FROM fixtures
     WHERE status = 'scheduled'
       AND kickoff_at < NOW() - ($1 || ' hours')::interval
     LIMIT 30`,
    [String(hours)],
  );
  let n = 0;
  for (const f of rows) {
    try {
      // Bye (null taraf) → iptal
      if (!f.home_club_id || !f.away_club_id) {
        await query(
          `UPDATE fixtures SET status = 'finished', home_goals = 0, away_goals = 0
           WHERE id = $1`,
          [f.id],
        );
      } else {
        // 3-0 forfeit home
        await leagueRepo.applyMatchResult(f.id, 3, 0, null);
      }
      n++;
    } catch (e) {
      console.warn("[seasonAuto] overdue", f.id, e.message);
    }
  }
  return { ok: true, forfeited: n };
}

async function finalizeCompletedSeasons() {
  const { rows } = await query(
    `SELECT s.id
     FROM seasons s
     WHERE s.is_current = TRUE
       AND EXISTS (SELECT 1 FROM fixtures f WHERE f.season_id = s.id)
       AND NOT EXISTS (
         SELECT 1 FROM fixtures f
         WHERE f.season_id = s.id AND f.status IN ('scheduled', 'live')
       )
     LIMIT 10`,
  );
  const results = [];
  for (const r of rows) {
    try {
      const fin = await seasonLifecycle.finalizeSeason(r.id, {});
      results.push(fin);
    } catch (e) {
      results.push({ ok: false, seasonId: r.id, error: e.message });
    }
  }
  return { ok: true, finalized: results.length, results };
}

/**
 * matchScheduler her ~4 tick'te bir çağırır.
 */
async function runSeasonAutomation() {
  const out = {
    pom: null,
    stuck: null,
    overdue: null,
    seasons: null,
    training: null,
  };
  try {
    out.pom = await finalizePlayerOfMonth();
  } catch (e) {
    out.pom = { error: e.message };
  }
  try {
    out.stuck = await cleanupStuckLive();
  } catch (e) {
    out.stuck = { error: e.message };
  }
  try {
    out.autoResolve = await autoResolveDueMatches();
  } catch (e) {
    out.autoResolve = { error: e.message };
  }
  try {
    out.overdue = await forfeitOverdue();
  } catch (e) {
    out.overdue = { error: e.message };
  }
  try {
    out.seasons = await finalizeCompletedSeasons();
  } catch (e) {
    out.seasons = { error: e.message };
  }
  try {
    out.training = await trainingAuto.runWeeklyTrainingAuto();
    await trainingAuto.runRestRecovery();
  } catch (e) {
    out.training = { error: e.message };
  }
  return out;
}

module.exports = {
  runSeasonAutomation,
  finalizePlayerOfMonth,
  cleanupStuckLive,
  autoResolveDueMatches,
  forfeitOverdue,
  finalizeCompletedSeasons,
};
