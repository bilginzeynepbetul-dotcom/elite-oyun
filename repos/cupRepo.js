// ============================================================
// repos/cupRepo.js — Kupa (tek eleme) sistemi
// ------------------------------------------------------------
// leagueRepo ile aynı desenler (query/withTransaction), ama tamamen
// ayrı tablolar (cup_editions, cup_fixtures) kullanır — lig kodunu
// hiç etkilemez.
// ============================================================

const { query, withTransaction } = require("../db");

const FIRST_ROUND_OFFSET_MS = 3 * 60 * 1000; // ilk tur ~3 dk sonra başlar (test/demo dostu)
const ROUND_GAP_MS = 15 * 60 * 1000; // bir sonraki tur, öncekinin bitiminden ~15 dk sonra
const MATCH_SPACING_MS = 2 * 60 * 1000; // aynı tur içindeki maçlar art arda değil, biraz aralıklı

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** N takım için gereken tur sayısı (2 → 1, 8 → 3, 10 → 4 [byelı], ...) */
function roundsForSize(n) {
  let rounds = 0;
  let size = 1;
  while (size < n) {
    size *= 2;
    rounds++;
  }
  return rounds;
}

function roundLabel(round, totalRounds) {
  const remaining = totalRounds - round + 1; // finale kaç tur kaldı (bu tur dahil)
  if (remaining === 1) return "Final";
  if (remaining === 2) return "Yarı Final";
  if (remaining === 3) return "Çeyrek Final";
  if (remaining === 4) return "Son 16";
  if (remaining === 5) return "Son 32";
  return "Tur " + round;
}

async function getCurrentEdition(country = "Türkiye") {
  const { rows } = await query(
    `SELECT id, country, year_label AS "yearLabel", is_current AS "isCurrent",
            current_round AS "currentRound", total_rounds AS "totalRounds",
            champion_club_id AS "championClubId"
     FROM cup_editions
     WHERE country = $1 AND is_current = TRUE
     ORDER BY id DESC LIMIT 1`,
    [country],
  );
  return rows[0] || null;
}

/** İlk turu (byes dahil) oluşturur ve edition'ı insert eder. */
async function createEdition(country, yearLabel, clubIds, opts = {}) {
  if (clubIds.length < 2) {
    return { ok: false, error: "Kupa için en az 2 kulüp gerekli" };
  }
  return withTransaction(async (client) => {
    const totalRounds = roundsForSize(clubIds.length);
    const { rows: edRows } = await client.query(
      `INSERT INTO cup_editions (country, year_label, is_current, current_round, total_rounds)
       VALUES ($1, $2, TRUE, 1, $3)
       ON CONFLICT (country, year_label) DO UPDATE SET is_current = TRUE
       RETURNING id`,
      [country, yearLabel, totalRounds],
    );
    const editionId = edRows[0].id;

    const shuffled = shuffle(clubIds);
    const startAt = opts.startAt || new Date(Date.now() + FIRST_ROUND_OFFSET_MS);
    const pairs = [];
    for (let i = 0; i < shuffled.length; i += 2) {
      pairs.push([shuffled[i], shuffled[i + 1] || null]);
    }

    let slot = 0;
    for (const [home, away] of pairs) {
      if (!away) {
        // Bye — rakip yok, direkt tur atlar
        await client.query(
          `INSERT INTO cup_fixtures
             (edition_id, round, round_label, slot, home_club_id, away_club_id,
              status, winner_club_id)
           VALUES ($1, 1, $2, $3, $4, NULL, 'bye', $4)`,
          [editionId, roundLabel(1, totalRounds), slot, home],
        );
      } else {
        const kickoff = new Date(startAt.getTime() + slot * MATCH_SPACING_MS);
        await client.query(
          `INSERT INTO cup_fixtures
             (edition_id, round, round_label, slot, home_club_id, away_club_id,
              kickoff_at, status)
           VALUES ($1, 1, $2, $3, $4, $5, $6, 'scheduled')`,
          [editionId, roundLabel(1, totalRounds), slot, home, away, kickoff.toISOString()],
        );
      }
      slot++;
    }

    return { ok: true, editionId, totalRounds, pairsCreated: pairs.length };
  });
}

/** country'deki tüm kulüpler (divizyon farketmeksizin — kupa milli çapta). */
async function listClubIdsForCountry(country) {
  const { rows } = await query(`SELECT id FROM clubs WHERE country = $1`, [country]);
  return rows.map((r) => r.id);
}

/** Aktif edition yoksa (veya hiç kupa oynanmadıysa) yenisini açar. */
async function ensureEditionExists(country = "Türkiye") {
  const existing = await getCurrentEdition(country);
  if (existing) return existing;
  const clubIds = await listClubIdsForCountry(country);
  if (clubIds.length < 2) return null;
  const yearLabel = String(new Date().getFullYear()) + "/" + String(new Date().getFullYear() + 1).slice(2);
  const res = await createEdition(country, yearLabel, clubIds);
  if (!res.ok) return null;
  return getCurrentEdition(country);
}

async function getBracket(editionId) {
  const { rows } = await query(
    `SELECT cf.id, cf.round, cf.round_label AS "roundLabel", cf.slot,
            cf.home_club_id AS "homeClubId", cf.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            cf.kickoff_at AS "kickoffAt", cf.status,
            cf.home_goals AS "homeGoals", cf.away_goals AS "awayGoals",
            cf.penalties, cf.winner_club_id AS "winnerClubId",
            wc.name AS "winnerName"
     FROM cup_fixtures cf
     LEFT JOIN clubs hc ON hc.id = cf.home_club_id
     LEFT JOIN clubs ac ON ac.id = cf.away_club_id
     LEFT JOIN clubs wc ON wc.id = cf.winner_club_id
     WHERE cf.edition_id = $1
     ORDER BY cf.round ASC, cf.slot ASC`,
    [editionId],
  );
  return rows;
}

async function getFixtureById(fixtureId) {
  const { rows } = await query(
    `SELECT cf.id, cf.edition_id AS "editionId", cf.round, cf.round_label AS "roundLabel",
            cf.home_club_id AS "homeClubId", cf.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            cf.kickoff_at AS "kickoffAt", cf.status,
            cf.home_goals AS "homeGoals", cf.away_goals AS "awayGoals",
            cf.match_id AS "matchId"
     FROM cup_fixtures cf
     JOIN clubs hc ON hc.id = cf.home_club_id
     JOIN clubs ac ON ac.id = cf.away_club_id
     WHERE cf.id = $1`,
    [fixtureId],
  );
  return rows[0] || null;
}

async function getNextFixtureForClub(clubId) {
  const { rows } = await query(
    `SELECT cf.id, cf.edition_id AS "editionId", cf.round, cf.round_label AS "roundLabel",
            cf.home_club_id AS "homeClubId", cf.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            cf.kickoff_at AS "kickoffAt", cf.status
     FROM cup_fixtures cf
     JOIN clubs hc ON hc.id = cf.home_club_id
     JOIN clubs ac ON ac.id = cf.away_club_id
     WHERE (cf.home_club_id = $1 OR cf.away_club_id = $1)
       AND cf.status IN ('scheduled', 'live')
     ORDER BY CASE WHEN cf.status = 'live' THEN 0 ELSE 1 END, cf.kickoff_at ASC
     LIMIT 1`,
    [clubId],
  );
  return rows[0] || null;
}

async function setFixtureLive(fixtureId, matchId) {
  await query(
    `UPDATE cup_fixtures SET status = 'live', match_id = COALESCE($2, match_id)
     WHERE id = $1 AND status = 'scheduled'`,
    [fixtureId, matchId || null],
  );
}

/**
 * Sonucu işler. Berabere biterse (kupa maçında beraberlik olmaz) basit bir
 * ağırlıklı penaltı simülasyonu ile kazanan belirlenir — gerçek penaltı
 * atış-atış simülasyonu ayrı bir geliştirme konusu.
 */
async function applyMatchResult(fixtureId, homeGoals, awayGoals, matchId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM cup_fixtures WHERE id = $1 FOR UPDATE`,
      [fixtureId],
    );
    const f = rows[0];
    if (!f) return { ok: false, error: "Fikstür yok" };
    if (f.status === "finished") return { ok: false, error: "Zaten bitmiş" };

    const hg = Number(homeGoals);
    const ag = Number(awayGoals);
    let winnerClubId;
    let penalties = false;
    if (hg > ag) winnerClubId = f.home_club_id;
    else if (ag > hg) winnerClubId = f.away_club_id;
    else {
      penalties = true;
      // Kaba ama makul bir penaltı ihtimali: %50/%50 (ileride takım
      // gücüne göre ağırlıklandırılabilir)
      winnerClubId = Math.random() < 0.5 ? f.home_club_id : f.away_club_id;
    }

    await client.query(
      `UPDATE cup_fixtures
       SET status = 'finished', home_goals = $2, away_goals = $3,
           penalties = $4, winner_club_id = $5, match_id = COALESCE($6, match_id)
       WHERE id = $1`,
      [fixtureId, hg, ag, penalties, winnerClubId, matchId || null],
    );

    return {
      ok: true,
      editionId: f.edition_id,
      round: f.round,
      homeClubId: f.home_club_id,
      awayClubId: f.away_club_id,
      winnerClubId,
      penalties,
      homeGoals: hg,
      awayGoals: ag,
    };
  });
}

/**
 * Her is_current edition için: mevcut tur tamamen bitmiş mi (finished/bye)?
 * Bittiyse ya şampiyonu ilan eder ya da sıradaki turu oluşturur.
 * server.js'deki scheduler tick'inden periyodik çağrılır.
 */
async function advanceReadyEditions() {
  const { rows: editions } = await query(
    `SELECT id, country, current_round AS "currentRound", total_rounds AS "totalRounds"
     FROM cup_editions WHERE is_current = TRUE`,
  );
  const advanced = [];
  for (const ed of editions) {
    try {
      const { rows: pending } = await query(
        `SELECT COUNT(*)::int AS c FROM cup_fixtures
         WHERE edition_id = $1 AND round = $2 AND status IN ('scheduled', 'live')`,
        [ed.id, ed.currentRound],
      );
      if (pending[0].c > 0) continue; // tur henüz bitmedi

      const { rows: winners } = await query(
        `SELECT slot, winner_club_id AS "winnerClubId"
         FROM cup_fixtures WHERE edition_id = $1 AND round = $2 ORDER BY slot ASC`,
        [ed.id, ed.currentRound],
      );
      if (!winners.length) continue;
      const winnerIds = winners.map((w) => w.winnerClubId).filter(Boolean);

      if (winnerIds.length <= 1) {
        // Şampiyon belli
        await query(
          `UPDATE cup_editions SET is_current = FALSE, champion_club_id = $2 WHERE id = $1`,
          [ed.id, winnerIds[0] || null],
        );
        advanced.push({ editionId: ed.id, champion: winnerIds[0] || null });
        continue;
      }

      const nextRound = ed.currentRound + 1;
      const label = roundLabel(nextRound, ed.totalRounds);
      const startAt = new Date(Date.now() + ROUND_GAP_MS);
      let slot = 0;
      for (let i = 0; i < winnerIds.length; i += 2) {
        const home = winnerIds[i];
        const away = winnerIds[i + 1] || null;
        if (!away) {
          await query(
            `INSERT INTO cup_fixtures
               (edition_id, round, round_label, slot, home_club_id, away_club_id, status, winner_club_id)
             VALUES ($1, $2, $3, $4, $5, NULL, 'bye', $5)`,
            [ed.id, nextRound, label, slot, home],
          );
        } else {
          const kickoff = new Date(startAt.getTime() + slot * MATCH_SPACING_MS);
          await query(
            `INSERT INTO cup_fixtures
               (edition_id, round, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
            [ed.id, nextRound, label, slot, home, away, kickoff.toISOString()],
          );
        }
        slot++;
      }
      await query(`UPDATE cup_editions SET current_round = $2 WHERE id = $1`, [ed.id, nextRound]);
      advanced.push({ editionId: ed.id, nextRound });
    } catch (e) {
      console.warn("[cupRepo] advanceReadyEditions", ed.id, e.message);
    }
  }
  return advanced;
}

async function listDueFixtures(limit = 20) {
  const { rows } = await query(
    `SELECT id, kickoff_at AS "kickoffAt" FROM cup_fixtures
     WHERE status = 'scheduled' AND kickoff_at <= NOW()
     ORDER BY kickoff_at ASC LIMIT $1`,
    [limit],
  );
  return rows;
}

module.exports = {
  getCurrentEdition,
  createEdition,
  listClubIdsForCountry,
  ensureEditionExists,
  getBracket,
  getFixtureById,
  getNextFixtureForClub,
  setFixtureLive,
  applyMatchResult,
  advanceReadyEditions,
  listDueFixtures,
  roundLabel,
  roundsForSize,
};
