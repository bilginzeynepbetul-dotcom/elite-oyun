// ============================================================
// seasonLifecycle.js — Sezon kapanışı otomasyonu
// ------------------------------------------------------------
// Tüm lig maçları bitince:
//   1) Şampiyon + final puan durumu kaydı
//   2) Gol/asist/yılın oyuncusu ödülleri
//   3) Küme düşme / yükselme (üst 2 / alt 2, komşu division varsa)
//   4) Eski sezonu kapat, yeni sezon aç, fikstür üret
// ============================================================

const { query, withTransaction } = require("./db");
const leagueRepo = require("./repos/leagueRepo");
const statsSystem = require("./statsSystem");

/** "2025/26" → "2026/27" */
function nextYearLabel(label) {
  const s = String(label || "").trim();
  const m = s.match(/^(\d{4})\s*\/\s*(\d{2,4})$/);
  if (m) {
    const y1 = parseInt(m[1], 10) + 1;
    let y2 = m[2];
    if (y2.length === 2) y2 = String((parseInt(y2, 10) + 1) % 100).padStart(2, "0");
    else y2 = String(parseInt(y2, 10) + 1);
    return y1 + "/" + y2;
  }
  const y = parseInt(s, 10);
  if (Number.isFinite(y) && y > 1900) return String(y + 1);
  return s || "2026/27";
}

async function countFixturesByStatus(seasonId) {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS c FROM fixtures
     WHERE season_id = $1 GROUP BY status`,
    [seasonId],
  );
  const out = { scheduled: 0, live: 0, finished: 0, cancelled: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.c;
    out.total += r.c;
  }
  return out;
}

/**
 * Sezonun tüm (iptal dışı) maçları bitti mi?
 */
async function isSeasonComplete(seasonId) {
  const c = await countFixturesByStatus(seasonId);
  if (c.total === 0) return false;
  const open = (c.scheduled || 0) + (c.live || 0);
  return open === 0 && (c.finished || 0) > 0;
}

/**
 * Lig maçı bittikten sonra çağrılır — gerekirse sezonu kapatır.
 * @returns {object|null} finalize sonucu veya null (henüz bitmedi)
 */
async function tryFinalizeAfterLeagueMatch(fixtureId) {
  if (!fixtureId) return null;
  const fixture = await leagueRepo.getFixtureById(fixtureId);
  if (!fixture || !fixture.seasonId) return null;

  const seasonId = fixture.seasonId;
  const { rows: seasonRows } = await query(
    `SELECT id, country, division, year_label AS "yearLabel",
            is_current AS "isCurrent", status, champion_club_id AS "championClubId"
     FROM seasons WHERE id = $1`,
    [seasonId],
  );
  const season = seasonRows[0];
  if (!season) return null;
  if (season.status === "finished" || season.championClubId) {
    return { skipped: true, reason: "already_finished", seasonId };
  }
  if (!(await isSeasonComplete(seasonId))) {
    return null;
  }
  return finalizeSeason(seasonId, { openNext: true });
}

/**
 * Sezonu kapatır: şampiyon, ödüller, (opsiyonel) küme, yeni sezon.
 */
async function finalizeSeason(seasonId, opts = {}) {
  const openNext = opts.openNext !== false;
  const doPromotion = opts.promotion !== false;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, country, division, year_label AS "yearLabel",
              is_current AS "isCurrent", status, champion_club_id
       FROM seasons WHERE id = $1 FOR UPDATE`,
      [seasonId],
    );
    const season = rows[0];
    if (!season) throw new Error("Sezon yok");
    if (season.status === "finished" || season.champion_club_id) {
      return { ok: true, skipped: true, reason: "already_finished", seasonId };
    }

    // Hâlâ açık maç var mı?
    const { rows: openRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM fixtures
       WHERE season_id = $1 AND status IN ('scheduled', 'live')`,
      [seasonId],
    );
    if (openRows[0] && openRows[0].c > 0) {
      return { ok: false, reason: "fixtures_open", open: openRows[0].c };
    }

    const standings = await leagueRepo.getStandings(seasonId);
    if (!standings.length) {
      return { ok: false, reason: "empty_standings" };
    }

    const champion = standings[0];
    const championClubId = champion.clubId;
    const championName = champion.name || "Şampiyon";

    await client.query(
      `UPDATE seasons SET
         is_current = FALSE,
         status = 'finished',
         champion_club_id = $2,
         champion_name = $3,
         finished_at = NOW()
       WHERE id = $1`,
      [seasonId, championClubId, championName],
    );

    // Kulüp ödülü: league_champion
    await client.query(
      `INSERT INTO season_awards
         (season_id, award_type, player_id, player_name, club_name, value, meta)
       VALUES ($1, 'league_champion', NULL, $2, $2, $3, $4::jsonb)`,
      [
        seasonId,
        championName,
        Number(champion.pts) || 0,
        JSON.stringify({
          clubId: championClubId,
          played: champion.played,
          gd: champion.gd,
          pts: champion.pts,
        }),
      ],
    );

    let awards = {};
    try {
      awards = await statsSystem.finalizeSeason(seasonId);
    } catch (e) {
      console.error("[seasonLifecycle] awards", e.message);
    }

    let promotion = null;
    if (doPromotion) {
      try {
        promotion = await applyPromotionRelegation(
          client,
          season.country,
          season.division,
          standings,
        );
      } catch (e) {
        console.error("[seasonLifecycle] promotion", e.message);
      }
    }

    let nextSeason = null;
    let fixturesGenerated = 0;
    if (openNext) {
      const yl = nextYearLabel(season.year_label || season.yearLabel);
      // Aynı country+division için diğer current'ları kapat
      await client.query(
        `UPDATE seasons SET is_current = FALSE
         WHERE country = $1 AND division = $2 AND is_current = TRUE`,
        [season.country, season.division],
      );
      const ins = await client.query(
        `INSERT INTO seasons (country, division, year_label, is_current, status)
         VALUES ($1, $2, $3, TRUE, 'active')
         ON CONFLICT (country, division, year_label)
           DO UPDATE SET is_current = TRUE, status = 'active',
             champion_club_id = NULL, champion_name = NULL, finished_at = NULL
         RETURNING id, country, division, year_label AS "yearLabel", is_current AS "isCurrent"`,
        [season.country, season.division, yl],
      );
      nextSeason = ins.rows[0] || null;

      if (nextSeason) {
        // Standings: bu division'daki tüm kulüpler
        const { rows: clubRows } = await client.query(
          `SELECT id FROM clubs WHERE country = $1 AND division = $2`,
          [season.country, season.division],
        );
        for (const c of clubRows) {
          await client.query(
            `INSERT INTO league_standings (season_id, club_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [nextSeason.id, c.id],
          );
        }
      }
    }

    // Fikstür transaction dışında (uzun sürebilir) — sonra
    const result = {
      ok: true,
      seasonId,
      country: season.country,
      division: season.division,
      yearLabel: season.year_label || season.yearLabel,
      champion: {
        clubId: championClubId,
        name: championName,
        pts: champion.pts,
      },
      standings: standings.slice(0, 8).map((r) => ({
        name: r.name,
        pts: r.pts,
        clubId: r.clubId,
      })),
      awards,
      promotion,
      nextSeason,
      fixturesGenerated: 0,
    };

    // Transaction commit sonrası fikstür
    process.nextTick(async () => {
      if (!nextSeason || !nextSeason.id) return;
      try {
        const gen = await leagueRepo.generateFixturesForSeason(nextSeason.id, {
          force: true,
        });
        console.log(
          "[seasonLifecycle] next season fixtures",
          nextSeason.id,
          gen && gen.count,
        );
      } catch (e) {
        console.error("[seasonLifecycle] generateFixtures", e.message);
      }
    });

    console.log(
      "[seasonLifecycle] finalized",
      season.country,
      "div",
      season.division,
      "champion",
      championName,
    );
    return result;
  });
}

/**
 * Üst 2 yükselir, alt 2 düşer (komşu division varsa).
 */
async function applyPromotionRelegation(client, country, division, standings) {
  const div = Number(division) || 1;
  const n = standings.length;
  if (n < 4) return { skipped: true, reason: "too_few_teams" };

  const promoteCount = Math.min(2, Math.floor(n / 4) || 1);
  const relegateCount = promoteCount;

  const promoted = [];
  const relegated = [];

  // Alt division var mı?
  const lowerDiv = div + 1;
  const { rows: lowerClubs } = await client.query(
    `SELECT id FROM clubs WHERE country = $1 AND division = $2 LIMIT 1`,
    [country, lowerDiv],
  );
  const hasLower = lowerClubs.length > 0;

  // Üst division var mı? (division > 1)
  const upperDiv = div - 1;
  const hasUpper = div > 1;

  if (hasLower) {
    // Bu division'ın son sıradakileri düşer
    const toRelegate = standings.slice(-relegateCount);
    for (const row of toRelegate) {
      await client.query(
        `UPDATE clubs SET division = $2 WHERE id = $1`,
        [row.clubId, lowerDiv],
      );
      relegated.push({ clubId: row.clubId, name: row.name, to: lowerDiv });
    }
    // Alt division'ın liderlerini yükselt
    const { rows: lowerStandings } = await client.query(
      `SELECT ls.club_id AS "clubId", c.name, ls.pts
       FROM league_standings ls
       JOIN clubs c ON c.id = ls.club_id
       JOIN seasons s ON s.id = ls.season_id
       WHERE s.country = $1 AND s.division = $2 AND s.is_current = TRUE
       ORDER BY ls.pts DESC, (ls.gf - ls.ga) DESC, ls.gf DESC
       LIMIT $3`,
      [country, lowerDiv, promoteCount],
    );
    // Eğer alt division standings yoksa, alt division kulüplerinden rastgele değil — isim sırası
    let upList = lowerStandings;
    if (!upList.length) {
      const { rows: anyLower } = await client.query(
        `SELECT id AS "clubId", name FROM clubs
         WHERE country = $1 AND division = $2
         ORDER BY name ASC LIMIT $3`,
        [country, lowerDiv, promoteCount],
      );
      upList = anyLower;
    }
    for (const row of upList) {
      await client.query(
        `UPDATE clubs SET division = $2 WHERE id = $1`,
        [row.clubId, div],
      );
      promoted.push({
        clubId: row.clubId,
        name: row.name,
        to: div,
        from: lowerDiv,
      });
    }
  }

  if (hasUpper) {
    // Bu division liderleri üste çıkar (üst zaten kendi kapanışında altından çekecek)
    // Çift işlem olmasın diye: sadece division 2+ kapanırken üste gönder
    const toPromote = standings.slice(0, promoteCount);
    for (const row of toPromote) {
      // Zaten promoted listesinde olabilir
      if (promoted.some((p) => String(p.clubId) === String(row.clubId))) continue;
      await client.query(
        `UPDATE clubs SET division = $2 WHERE id = $1`,
        [row.clubId, upperDiv],
      );
      promoted.push({
        clubId: row.clubId,
        name: row.name,
        to: upperDiv,
        from: div,
      });
    }
  }

  return { promoted, relegated, promoteCount, relegateCount };
}

/**
 * Geçmiş şampiyonlar (UI tarihçe).
 */
async function listSeasonHistory(country, division, limit = 20) {
  const { rows } = await query(
    `SELECT s.id, s.year_label AS "yearLabel", s.division,
            s.champion_club_id AS "championClubId",
            s.champion_name AS "championName",
            s.finished_at AS "finishedAt",
            s.status
     FROM seasons s
     WHERE s.country = $1 AND s.division = $2
       AND (s.status = 'finished' OR s.champion_club_id IS NOT NULL)
     ORDER BY s.finished_at DESC NULLS LAST, s.id DESC
     LIMIT $3`,
    [country || "Türkiye", division || 1, limit],
  );
  return rows;
}

module.exports = {
  nextYearLabel,
  countFixturesByStatus,
  isSeasonComplete,
  tryFinalizeAfterLeagueMatch,
  finalizeSeason,
  listSeasonHistory,
};
