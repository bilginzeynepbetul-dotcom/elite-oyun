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

/**
 * Sezon öncesi: ilk lig maçından önce (hazırlık 2 hafta).
 */
async function isPreSeasonWindow(country) {
  try {
    const c = country || "Türkiye";
    const { rows } = await query(
      `SELECT MIN(f.kickoff_at) AS first_kick
       FROM fixtures f
       JOIN seasons s ON s.id = f.season_id
       WHERE s.country = $1 AND s.is_current = TRUE AND s.division = 1
         AND f.status IN ('scheduled', 'live', 'finished')`,
      [c],
    );
    const first =
      rows[0] && rows[0].first_kick ? new Date(rows[0].first_kick) : null;
    if (!first || Number.isNaN(first.getTime())) {
      return { preSeason: true, reason: "no_fixtures" };
    }
    const now = Date.now();
    if (now < first.getTime()) {
      return {
        preSeason: true,
        reason: "before_first_match",
        firstKickoff: first.toISOString(),
      };
    }
    return { preSeason: false, firstKickoff: first.toISOString() };
  } catch (_) {
    return { preSeason: false };
  }
}

async function canPlayFriendly(clubId) {
  const club = await clubsRepo.getClub(clubId);
  if (!club) return { ok: false, error: "Kulüp yok" };

  const pre = await isPreSeasonWindow(club.country);
  if (pre.preSeason) {
    return {
      ok: true,
      inCup: false,
      preSeason: true,
      club,
      hint: "Sezon öncesi hazırlık (2 hafta, haftada 2 maç)",
    };
  }

  const inCup = await isStillInCup(clubId, club.country);
  if (inCup) {
    return {
      ok: false,
      error:
        "Hâlâ lig kupası maçın var — elendikten sonra Perşembe 13:00 TR dostluk oynayabilirsin",
      inCup: true,
      preSeason: false,
    };
  }
  return {
    ok: true,
    inCup: false,
    preSeason: false,
    club,
    hint: "Lig kupasından elendin — dostluk Perşembe 13:00 TR (kupa saati)",
  };
}

/** Kulüp bot mu? (is_bot veya user_id yok) */
function clubIsBot(club) {
  if (!club) return true;
  if (club.is_bot === true || club.isBot === true) return true;
  if (club.user_id == null && club.userId == null) return true;
  return false;
}

/**
 * Dostluk teklifi.
 * - İnsan rakip → pending; kabul edilince scheduled maç oluşur
 * - Bot rakip → hemen scheduled (anında kabul)
 * - kickoff: en az 1 dk sonra; maç saatine kadar serbest
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

  let kick = kickoffAt ? new Date(kickoffAt) : null;
  if (!kick || Number.isNaN(kick.getTime())) {
    // Varsayılan: bir sonraki Perşembe 13:00 TR
    try {
      const cal = require("./calendarSchedule");
      kick = cal.nextThursday1300TR();
    } catch (_) {
      kick = new Date(Date.now() + 60 * 60 * 1000);
    }
  }
  // Maç saatine kadar teklif: kickoff geçmişse sonraki Perşembe'ye kaydır
  if (kick.getTime() < Date.now() + 60 * 1000) {
    try {
      const cal = require("./calendarSchedule");
      kick = cal.nextThursday1300TR();
    } catch (_) {
      kick = new Date(Date.now() + 30 * 60 * 1000);
    }
  }

  // Aynı çift için açık pending/scheduled çakışması (2 saat pencere)
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

  let awayClub = null;
  try {
    awayClub = await clubsRepo.getClub(awayClubId);
  } catch (_) {}
  const awayIsBot = clubIsBot(awayClub);
  // Bot → hemen maç oluştur (scheduled); insan → kabul bekler
  const status = awayIsBot ? "scheduled" : "pending";

  const { rows } = await query(
    `INSERT INTO friendly_fixtures
       (home_club_id, away_club_id, kickoff_at, status, proposed_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kickoff_at AS "kickoffAt", status,
               home_club_id AS "homeClubId", away_club_id AS "awayClubId"`,
    [homeClubId, awayClubId, kick.toISOString(), status, userId || null],
  );
  const fixture = rows[0];
  return {
    ok: true,
    fixture,
    autoAccepted: awayIsBot,
    status,
    message: awayIsBot
      ? "Bot rakip hemen kabul etti — dostluk maçı oluşturuldu"
      : "Teklif gönderildi — rakip kabul ederse maç oluşur",
  };
}

/**
 * Teklif yanıtı: kabul → status=scheduled (sıradaki dostluk maçı hazır)
 */
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
  const isAway = String(f.away_club_id) === String(clubId);
  const isHome = String(f.home_club_id) === String(clubId);
  if (!isAway && !isHome) {
    return { ok: false, error: "Bu maç sana ait değil" };
  }
  // Teklifi alan (away) yanıtlar
  if (!isAway) {
    return { ok: false, error: "Teklifi rakip taraf yanıtlar" };
  }

  if (!accept) {
    await query(
      `UPDATE friendly_fixtures SET status = 'declined', updated_at = NOW() WHERE id = $1`,
      [fixtureId],
    );
    return { ok: true, status: "declined", message: "Teklif reddedildi" };
  }

  // Kabul öncesi uygunluk
  const a = await canPlayFriendly(f.home_club_id);
  const b = await canPlayFriendly(f.away_club_id);
  if (!a.ok || !b.ok) {
    await query(
      `UPDATE friendly_fixtures SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
      [fixtureId],
    );
    return {
      ok: false,
      error: "Taraflardan biri artık uygun değil — teklif iptal",
    };
  }

  // Kickoff geçmişse sonraki Perşembe 13:00 TR
  let kick = f.kickoff_at ? new Date(f.kickoff_at) : null;
  if (!kick || kick.getTime() < Date.now() + 60 * 1000) {
    try {
      const cal = require("./calendarSchedule");
      kick = cal.nextThursday1300TR();
    } catch (_) {
      kick = new Date(Date.now() + 60 * 60 * 1000);
    }
    await query(
      `UPDATE friendly_fixtures
       SET status = 'scheduled', kickoff_at = $2, updated_at = NOW()
       WHERE id = $1`,
      [fixtureId, kick.toISOString()],
    );
  } else {
    await query(
      `UPDATE friendly_fixtures SET status = 'scheduled', updated_at = NOW() WHERE id = $1`,
      [fixtureId],
    );
  }

  const created = await getById(fixtureId);
  return {
    ok: true,
    status: "scheduled",
    fixtureId,
    fixture: created,
    kickoffAt: kick ? kick.toISOString() : null,
    message: "Kabul edildi — dostluk maçı oluşturuldu",
  };
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
  // Eski bekleyen teklifleri temizle (>48 saat)
  try {
    await query(
      `UPDATE friendly_fixtures SET status = 'cancelled', updated_at = NOW()
       WHERE status = 'pending'
         AND kickoff_at < NOW() - INTERVAL '1 hour'
         AND created_at < NOW() - INTERVAL '48 hours'`,
    );
  } catch (_) {
    try {
      await query(
        `UPDATE friendly_fixtures SET status = 'cancelled', updated_at = NOW()
         WHERE status = 'pending'
           AND kickoff_at < NOW() - INTERVAL '2 hours'`,
      );
    } catch (__) {}
  }

  const { rows } = await query(
    `SELECT f.id, f.kickoff_at AS "kickoffAt", f.status,
            f.home_goals AS "homeGoals", f.away_goals AS "awayGoals",
            f.home_club_id AS "homeClubId", f.away_club_id AS "awayClubId",
            f.proposed_by AS "proposedBy",
            f.match_id AS "matchId",
            hc.name AS "homeName", ac.name AS "awayName"
     FROM friendly_fixtures f
     JOIN clubs hc ON hc.id = f.home_club_id
     JOIN clubs ac ON ac.id = f.away_club_id
     WHERE f.home_club_id = $1 OR f.away_club_id = $1
     ORDER BY
       CASE f.status
         WHEN 'live' THEN 0
         WHEN 'pending' THEN 1
         WHEN 'scheduled' THEN 2
         ELSE 3
       END,
       f.kickoff_at DESC
     LIMIT 40`,
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

/** Bu hafta (Pzt 00:00 UTC → +7g) pending/scheduled/live dostluk sayısı */
async function countFriendliesThisWeek(clubId) {
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c FROM friendly_fixtures
       WHERE (home_club_id = $1 OR away_club_id = $1)
         AND status IN ('pending', 'scheduled', 'live', 'finished')
         AND kickoff_at >= date_trunc('week', NOW() AT TIME ZONE 'UTC')
         AND kickoff_at < date_trunc('week', NOW() AT TIME ZONE 'UTC') + INTERVAL '7 days'`,
      [clubId],
    );
    return (rows[0] && rows[0].c) || 0;
  } catch (_) {
    return 0;
  }
}

/** Bu hafta dostluk limiti doldu mu? (sezon içi 1, sezon öncesi 2) */
async function hasFriendlyThisWeek(clubId, maxPerWeek) {
  const max = maxPerWeek != null ? maxPerWeek : 1;
  const n = await countFriendliesThisWeek(clubId);
  return n >= max;
}

/**
 * Otomatik dostluk planı (onay beklemez → scheduled).
 * Kupa elenmiş / kupada olmayan takımlar için.
 */
async function autoSchedule(homeClubId, awayClubId, kickoffAt) {
  if (!homeClubId || !awayClubId || homeClubId === awayClubId) {
    return { ok: false, error: "Geçersiz takımlar" };
  }
  const a = await canPlayFriendly(homeClubId);
  if (!a.ok) return a;
  const b = await canPlayFriendly(awayClubId);
  if (!b.ok) return { ok: false, error: b.error || "Rakip uygun değil" };

  // Haftalık limit: sezon öncesi 2, sezon içi 1
  let maxWeek = 1;
  try {
    const homeClub = await clubsRepo.getClub(homeClubId);
    const pre = homeClub
      ? await isPreSeasonWindow(homeClub.country)
      : { preSeason: false };
    if (pre.preSeason) maxWeek = 2;
  } catch (_) {}
  if (
    (await hasFriendlyThisWeek(homeClubId, maxWeek)) ||
    (await hasFriendlyThisWeek(awayClubId, maxWeek))
  ) {
    return { ok: false, error: "Bu hafta dostluk limiti doldu" };
  }

  const kick = kickoffAt instanceof Date ? kickoffAt : new Date(kickoffAt);
  if (Number.isNaN(kick.getTime())) {
    return { ok: false, error: "Geçersiz saat" };
  }
  if (kick.getTime() < Date.now() + 10 * 60 * 1000) {
    kick.setTime(Date.now() + 2 * 60 * 60 * 1000);
  }

  try {
    const { rows } = await query(
      `INSERT INTO friendly_fixtures
         (home_club_id, away_club_id, kickoff_at, status, proposed_by)
       VALUES ($1, $2, $3, 'scheduled', NULL)
       RETURNING id, kickoff_at AS "kickoffAt", status`,
      [homeClubId, awayClubId, kick.toISOString()],
    );
    return { ok: true, fixture: rows[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  isStillInCup,
  isPreSeasonWindow,
  canPlayFriendly,
  propose,
  respond,
  cancel,
  listForClub,
  listDue,
  setLive,
  finish,
  getById,
  countFriendliesThisWeek,
  hasFriendlyThisWeek,
  autoSchedule,
};
