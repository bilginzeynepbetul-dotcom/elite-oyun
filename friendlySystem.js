// ============================================================
// friendlySystem.js — Kupa dışı / elenen takımlar dostluk maçı
// ============================================================

const { query } = require("./db");
const clubsRepo = require("./repos/clubsRepo");
const cupRepo = require("./repos/cupRepo");

/**
 * Kulüp hâlâ aktif kupa turunda mı? (scheduled/live maçı var mı)
 * Elenen veya kupaya hiç girmemiş → dostluk oynayabilir.
 */
async function isStillInCup(clubId, country) {
  try {
    const edition = await cupRepo.getCurrentEdition(country || "Türkiye");
    if (!edition) return false;
    const { rows } = await query(
      `SELECT 1 FROM cup_fixtures
       WHERE edition_id = $1
         AND status IN ('scheduled', 'live')
         AND (home_club_id = $2 OR away_club_id = $2)
       LIMIT 1`,
      [edition.id, clubId],
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

async function canPlayFriendly(clubId) {
  const club = await clubsRepo.getClub(clubId);
  if (!club) return { ok: false, error: "Kulüp yok" };
  const inCup = await isStillInCup(clubId, club.country);
  if (inCup) {
    return {
      ok: false,
      error: "Hâlâ kupa maçın var — elendikten sonra dostluk ayarlayabilirsin",
      inCup: true,
    };
  }
  return { ok: true, inCup: false, club };
}

/**
 * Dostluk teklifi.
 * kickoffAt ISO; en az ~10 dk sonra.
 */
async function propose(homeClubId, awayClubId, kickoffAt, userId) {
  if (!homeClubId || !awayClubId || homeClubId === awayClubId) {
    return { ok: false, error: "Geçersiz takımlar" };
  }
  const a = await canPlayFriendly(homeClubId);
  if (!a.ok) return a;
  const b = await canPlayFriendly(awayClubId);
  if (!b.ok) {
    return {
      ok: false,
      error: "Rakip hâlâ kupada veya uygun değil: " + (b.error || ""),
    };
  }

  const kick = new Date(kickoffAt);
  if (Number.isNaN(kick.getTime())) {
    return { ok: false, error: "Geçersiz maç saati" };
  }
  if (kick.getTime() < Date.now() + 5 * 60 * 1000) {
    return { ok: false, error: "Dostluk en az 5 dakika sonrası olmalı" };
  }

  // Çakışan pending/scheduled dostluk var mı?
  const { rows: busy } = await query(
    `SELECT id FROM friendly_fixtures
     WHERE status IN ('pending', 'scheduled', 'live')
       AND (
         home_club_id IN ($1, $2) OR away_club_id IN ($1, $2)
       )
       AND ABS(EXTRACT(EPOCH FROM (kickoff_at - $3::timestamptz))) < 7200
     LIMIT 1`,
    [homeClubId, awayClubId, kick.toISOString()],
  );
  if (busy.length) {
    return { ok: false, error: "Bu saate yakın başka dostluk/plan var" };
  }

  const { rows } = await query(
    `INSERT INTO friendly_fixtures
       (home_club_id, away_club_id, kickoff_at, status, proposed_by)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING id, kickoff_at AS "kickoffAt", status`,
    [homeClubId, awayClubId, kick.toISOString(), userId || null],
  );
  return { ok: true, fixture: rows[0] };
}

async function respond(fixtureId, clubId, accept) {
  const { rows } = await query(
    `SELECT * FROM friendly_fixtures WHERE id = $1`,
    [fixtureId],
  );
  const f = rows[0];
  if (!f) return { ok: false, error: "Teklif yok" };
  if (f.status !== "pending") {
    return { ok: false, error: "Bu teklif artık beklemede değil" };
  }
  // Sadece rakip (teklif alan) kabul/red eder
  const isAway = String(f.away_club_id) === String(clubId);
  const isHome = String(f.home_club_id) === String(clubId);
  if (!isAway && !isHome) {
    return { ok: false, error: "Bu maç sana ait değil" };
  }
  // Teklif eden taraf home varsayımı; away kabul eder (basit)
  if (!isAway) {
    return { ok: false, error: "Teklifi rakip taraf yanıtlar" };
  }

  if (!accept) {
    await query(
      `UPDATE friendly_fixtures SET status = 'declined', updated_at = NOW() WHERE id = $1`,
      [fixtureId],
    );
    return { ok: true, status: "declined" };
  }

  // Kabul öncesi tekrar kupa kontrolü
  const a = await canPlayFriendly(f.home_club_id);
  const b = await canPlayFriendly(f.away_club_id);
  if (!a.ok || !b.ok) {
    await query(
      `UPDATE friendly_fixtures SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [fixtureId],
    );
    return { ok: false, error: "Taraflardan biri hâlâ kupada — iptal" };
  }

  await query(
    `UPDATE friendly_fixtures SET status = 'scheduled', updated_at = NOW() WHERE id = $1`,
    [fixtureId],
  );
  return { ok: true, status: "scheduled", fixtureId };
}

async function cancel(fixtureId, clubId) {
  const { rows } = await query(
    `UPDATE friendly_fixtures SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'scheduled')
       AND (home_club_id = $2 OR away_club_id = $2)
     RETURNING id`,
    [fixtureId, clubId],
  );
  if (!rows[0]) return { ok: false, error: "İptal edilemedi" };
  return { ok: true };
}

async function listForClub(clubId) {
  const { rows } = await query(
    `SELECT f.id, f.kickoff_at AS "kickoffAt", f.status,
            f.home_goals AS "homeGoals", f.away_goals AS "awayGoals",
            f.home_club_id AS "homeClubId", f.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName"
     FROM friendly_fixtures f
     JOIN clubs hc ON hc.id = f.home_club_id
     JOIN clubs ac ON ac.id = f.away_club_id
     WHERE f.home_club_id = $1 OR f.away_club_id = $1
     ORDER BY f.kickoff_at DESC
     LIMIT 30`,
    [clubId],
  );
  return rows;
}

async function listDue(limit) {
  const { rows } = await query(
    `SELECT id, home_club_id AS "homeClubId", away_club_id AS "awayClubId",
            kickoff_at AS "kickoffAt", status
     FROM friendly_fixtures
     WHERE status = 'scheduled' AND kickoff_at <= NOW()
     ORDER BY kickoff_at ASC
     LIMIT $1`,
    [limit || 10],
  );
  return rows;
}

async function setLive(fixtureId, matchId) {
  await query(
    `UPDATE friendly_fixtures SET status = 'live', match_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [fixtureId, matchId || null],
  );
}

async function finish(fixtureId, homeGoals, awayGoals) {
  await query(
    `UPDATE friendly_fixtures
     SET status = 'finished', home_goals = $2, away_goals = $3, updated_at = NOW()
     WHERE id = $1`,
    [fixtureId, homeGoals, awayGoals],
  );
}

async function getById(id) {
  const { rows } = await query(
    `SELECT id, home_club_id AS "homeClubId", away_club_id AS "awayClubId",
            kickoff_at AS "kickoffAt", status, match_id AS "matchId",
            home_goals AS "homeGoals", away_goals AS "awayGoals"
     FROM friendly_fixtures WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

module.exports = {
  isStillInCup,
  canPlayFriendly,
  propose,
  respond,
  cancel,
  listForClub,
  listDue,
  setLive,
  finish,
  getById,
};
