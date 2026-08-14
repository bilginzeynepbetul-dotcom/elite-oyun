// ============================================================
// matchNotify.js — Yaklaşan maç / maç günü bildirimleri (P1 #9)
// ------------------------------------------------------------
// Scheduler tick'inden çağrılır:
//   - kickoff'a PRE_MATCH_MIN dakika kala "maç yaklaşıyor"
//   - Maç başlarken "maç başladı" (opsiyonel, start hook)
// Aynı bildirim tekrarı: game_settings + bellek set
// ============================================================

const { query } = require("./db");
const seasonConfig = require("./seasonConfig");

const PRE_MATCH_MIN = Number(process.env.MATCH_NOTIFY_PRE_MIN || 60);
const START_NOTIFY = process.env.MATCH_NOTIFY_ON_START !== "0";

/** Bu process içinde gönderilen anahtarlar */
const sentLocal = new Set();
const MAX_LOCAL = 2000;

function key(fixtureId, kind) {
  return String(fixtureId) + ":" + kind;
}

function remember(k) {
  sentLocal.add(k);
  if (sentLocal.size > MAX_LOCAL) {
    const arr = Array.from(sentLocal);
    arr.slice(0, 500).forEach((x) => sentLocal.delete(x));
  }
}

async function wasSentPersistent(k) {
  try {
    const v = await seasonConfig.getSetting("notify:" + k, null);
    return !!v;
  } catch (_) {
    return false;
  }
}

async function markSentPersistent(k) {
  try {
    await seasonConfig.setSetting("notify:" + k, String(Date.now()));
  } catch (_) {}
}

async function alreadySent(fixtureId, kind) {
  const k = key(fixtureId, kind);
  if (sentLocal.has(k)) return true;
  if (await wasSentPersistent(k)) {
    remember(k);
    return true;
  }
  return false;
}

async function markSent(fixtureId, kind) {
  const k = key(fixtureId, kind);
  remember(k);
  await markSentPersistent(k);
}

function getSocial() {
  try {
    return require("./socialSystem");
  } catch (_) {
    return null;
  }
}

/**
 * Yaklaşan lig maçları için bildirim.
 * window: şimdi .. + PRE_MATCH_MIN dakika
 */
async function notifyUpcomingLeagueMatches() {
  const minutes = PRE_MATCH_MIN;
  const { rows } = await query(
    `SELECT f.id,
            f.home_club_id AS "homeClubId",
            f.away_club_id AS "awayClubId",
            f.kickoff_at AS "kickoffAt",
            hc.name AS "homeName",
            ac.name AS "awayName",
            hc.user_id AS "homeUserId",
            ac.user_id AS "awayUserId"
     FROM fixtures f
     JOIN clubs hc ON hc.id = f.home_club_id
     JOIN clubs ac ON ac.id = f.away_club_id
     WHERE f.status = 'scheduled'
       AND f.kickoff_at > NOW()
       AND f.kickoff_at <= NOW() + ($1 || ' minutes')::interval
     LIMIT 40`,
    [String(minutes)],
  );

  const social = getSocial();
  if (!social || typeof social.pushNotification !== "function") {
    return { notified: 0, reason: "no_social" };
  }

  let notified = 0;
  for (const f of rows) {
    if (await alreadySent(f.id, "pre")) continue;

    const kick = f.kickoffAt ? new Date(f.kickoffAt) : null;
    const when = kick
      ? kick.toLocaleString("tr-TR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "yakında";
    const title =
      (f.homeName || "Ev") + " vs " + (f.awayName || "Deplasman");
    const text = "Maç yaklaşıyor · " + title + " · " + when;

    const users = [f.homeUserId, f.awayUserId].filter(Boolean);
    for (const uid of users) {
      try {
        await social.pushNotification(uid, "🏟️", text, "match");
        notified++;
      } catch (e) {
        console.warn("[matchNotify] push", e.message);
      }
    }
    await markSent(f.id, "pre");
  }
  return { notified, scanned: rows.length };
}

/**
 * Maç başlarken (scheduler start sonrası).
 */
async function notifyMatchStarted(opts) {
  if (!START_NOTIFY) return { notified: 0 };
  opts = opts || {};
  const fixtureId = opts.fixtureId;
  if (!fixtureId) return { notified: 0 };
  if (await alreadySent(fixtureId, "start")) return { notified: 0, skipped: true };

  const social = getSocial();
  if (!social || typeof social.pushNotification !== "function") {
    return { notified: 0 };
  }

  let homeUserId = opts.homeUserId || null;
  let awayUserId = opts.awayUserId || null;
  let homeName = opts.homeName || "Ev";
  let awayName = opts.awayName || "Deplasman";

  if (!homeUserId && !awayUserId) {
    try {
      const { rows } = await query(
        `SELECT f.id,
                hc.name AS "homeName",
                ac.name AS "awayName",
                hc.user_id AS "homeUserId",
                ac.user_id AS "awayUserId"
         FROM fixtures f
         JOIN clubs hc ON hc.id = f.home_club_id
         JOIN clubs ac ON ac.id = f.away_club_id
         WHERE f.id = $1`,
        [fixtureId],
      );
      if (rows[0]) {
        homeUserId = rows[0].homeUserId;
        awayUserId = rows[0].awayUserId;
        homeName = rows[0].homeName || homeName;
        awayName = rows[0].awayName || awayName;
      }
    } catch (_) {}
  }

  const text =
    "Maç başladı · " + homeName + " vs " + awayName + " — canlı izleyebilirsin";
  let notified = 0;
  for (const uid of [homeUserId, awayUserId].filter(Boolean)) {
    try {
      await social.pushNotification(uid, "⚽", text, "match");
      notified++;
    } catch (_) {}
  }
  await markSent(fixtureId, "start");
  return { notified };
}

/**
 * Scheduler giriş noktası
 */
async function runMatchNotify() {
  try {
    return await notifyUpcomingLeagueMatches();
  } catch (e) {
    console.warn("[matchNotify]", e.message);
    return { error: e.message };
  }
}

module.exports = {
  runMatchNotify,
  notifyUpcomingLeagueMatches,
  notifyMatchStarted,
  PRE_MATCH_MIN,
};
