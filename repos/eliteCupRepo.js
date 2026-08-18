// ============================================================
// repos/eliteCupRepo.js — Elite Kupa
// 1. Lig 2. + 3. sıralar → ~128 takım → tek maçlı eleme
// 9 haftalık sezona sığacak kickoff aralığı
// ============================================================

const { query, withTransaction } = require("../db");

const SEASON_WEEKS = 9;
const SEASON_SPAN_MS = SEASON_WEEKS * 7 * 24 * 3600 * 1000;
const MATCH_SPACING_MS = Number(process.env.ELITE_CUP_MATCH_SPACING_MS) || 90 * 60 * 1000;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roundsForSize(n) {
  let rounds = 0;
  let size = 1;
  while (size < n) {
    size *= 2;
    rounds++;
  }
  return Math.max(1, rounds);
}

function roundLabel(round, totalRounds) {
  const remaining = totalRounds - round + 1;
  if (remaining === 1) return "Final";
  if (remaining === 2) return "Yarı Final";
  if (remaining === 3) return "Çeyrek Final";
  if (remaining === 4) return "Son 16";
  if (remaining === 5) return "Son 32";
  if (remaining === 6) return "Son 64";
  if (remaining === 7) return "Son 128";
  return "Tur " + round;
}

/** Tur aralığı: 9 haftayı (tur+1) dilimine böl */
function roundGapMs(totalRounds) {
  const parts = Math.max(2, (totalRounds || 7) + 1);
  return Math.floor(SEASON_SPAN_MS / parts);
}

async function getCurrentEdition() {
  const { rows } = await query(
    `SELECT id, year_label AS "yearLabel", is_current AS "isCurrent",
            current_round AS "currentRound", total_rounds AS "totalRounds",
            champion_club_id AS "championClubId",
            champion_name AS "championName", created_at AS "createdAt"
     FROM elite_cup_editions
     WHERE is_current = TRUE
     ORDER BY id DESC LIMIT 1`,
  );
  return rows[0] || null;
}

/**
 * Her ülkede kapanmış son 1. Lig sezonundan 2. ve 3. sıra.
 */
async function pickQualifiers() {
  try {
    const coeff = require("../countryCoefficient");
    const mode = await coeff.getAccessMode();
    if (mode.mode === "coefficient") {
      const picked = await coeff.pickClubsBySlots("elite");
      if (picked.ok && picked.clubs.length >= 4) {
        return picked.clubs.map((c) => ({
          id: c.id,
          name: c.name,
          country: c.country,
          pts: c.pts || 0,
          rank: c.domesticRank,
          seasonLabel: null,
        }));
      }
    }
  } catch (e) {
    console.warn("[eliteCup] coeff pick", e.message);
  }

  const { rows } = await query(
    `WITH last_season AS (
       SELECT DISTINCT ON (country)
              id, country, year_label
       FROM seasons
       WHERE division = 1 AND is_current = FALSE
       ORDER BY country, id DESC
     ),
     ranked AS (
       SELECT c.id, c.name, c.country,
              COALESCE(ls.pts, 0) AS pts,
              COALESCE(ls.gf - ls.ga, 0) AS gd,
              COALESCE(ls.gf, 0) AS gf,
              ROW_NUMBER() OVER (
                PARTITION BY c.country
                ORDER BY COALESCE(ls.pts, 0) DESC,
                         (COALESCE(ls.gf, 0) - COALESCE(ls.ga, 0)) DESC,
                         COALESCE(ls.gf, 0) DESC,
                         c.name ASC
              ) AS rk,
              ls_s.year_label AS "seasonLabel"
       FROM last_season ls_s
       JOIN league_standings ls ON ls.season_id = ls_s.id
       JOIN clubs c ON c.id = ls.club_id
     )
     SELECT id, name, country, pts, gd, gf, rk, "seasonLabel"
     FROM ranked
     WHERE rk IN (2, 3)
     ORDER BY country ASC, rk ASC`,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    pts: Number(r.pts) || 0,
    rank: Number(r.rk),
    seasonLabel: r.seasonLabel,
  }));
}

async function createEdition(yearLabel, opts = {}) {
  const qualifiers = await pickQualifiers();
  if (qualifiers.length < 4) {
    return {
      ok: false,
      error:
        "Elite Kupa için yeterli 2./3. sıra yok (önce 1. sezon bitmeli)",
      qualifiers,
    };
  }

  const cal = require("../calendarSchedule");
  const clubs = shuffle(qualifiers);
  const totalRounds = roundsForSize(clubs.length);
  // Ortak slot: Çarşamba 15:00 TR (Kıtasal Lig ile aynı)
  const startAt =
    opts.startAt instanceof Date
      ? opts.startAt
      : cal.nextWednesday1500TR();

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE elite_cup_editions SET is_current = FALSE WHERE is_current = TRUE`,
    );
    const ins = await client.query(
      `INSERT INTO elite_cup_editions
         (year_label, is_current, current_round, total_rounds)
       VALUES ($1, TRUE, 1, $2)
       RETURNING id, year_label AS "yearLabel", current_round AS "currentRound",
                 total_rounds AS "totalRounds"`,
      [yearLabel || "EK-" + new Date().getFullYear(), totalRounds],
    );
    const edition = ins.rows[0];

    // İlk tur eşleşmeleri — hepsi aynı Çarşamba 15:00 TR
    const ids = clubs.map((c) => c.id);
    let slot = 0;
    const pairs = [];
    for (let i = 0; i < Math.floor(ids.length / 2); i++) {
      pairs.push([ids[i * 2], ids[i * 2 + 1]]);
    }
    const byeId = ids.length % 2 === 1 ? ids[ids.length - 1] : null;
    const label = roundLabel(1, totalRounds);
    const koIso = startAt.toISOString();

    for (let i = 0; i < pairs.length; i++) {
      const [h, a] = pairs[i];
      await client.query(
        `INSERT INTO elite_cup_fixtures
           (edition_id, round, round_label, slot, home_club_id, away_club_id,
            kickoff_at, status)
         VALUES ($1, 1, $2, $3, $4, $5, $6, 'scheduled')`,
        [edition.id, label, slot++, h, a, koIso],
      );
    }
    if (byeId) {
      await client.query(
        `INSERT INTO elite_cup_fixtures
           (edition_id, round, round_label, slot, home_club_id, away_club_id,
            status, winner_club_id)
         VALUES ($1, 1, $2, $3, $4, NULL, 'bye', $4)`,
        [edition.id, label + " (bye)", slot++, byeId],
      );
    }

    return {
      ok: true,
      edition,
      qualifierCount: clubs.length,
      totalRounds,
      pairs: pairs.length,
      byes: byeId ? 1 : 0,
      startAt: startAt.toISOString(),
      kickoffSlot: "Çarşamba 15:00 TR",
      format: "elite_cup_single_elim",
      name: "Elite Kupa",
    };
  });
}

async function getFixtures(editionId) {
  const { rows } = await query(
    `SELECT ef.id, ef.round, ef.round_label AS "roundLabel", ef.slot,
            ef.home_club_id AS "homeClubId", ef.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            ef.kickoff_at AS "kickoffAt", ef.status,
            ef.home_goals AS "homeGoals", ef.away_goals AS "awayGoals",
            ef.penalties, ef.winner_club_id AS "winnerClubId"
     FROM elite_cup_fixtures ef
     LEFT JOIN clubs hc ON hc.id = ef.home_club_id
     LEFT JOIN clubs ac ON ac.id = ef.away_club_id
     WHERE ef.edition_id = $1
     ORDER BY ef.round ASC, ef.slot ASC`,
    [editionId],
  );
  return rows;
}

async function getFixtureById(fixtureId) {
  const { rows } = await query(
    `SELECT ef.id, ef.edition_id AS "editionId", ef.round, ef.round_label AS "roundLabel",
            ef.home_club_id AS "homeClubId", ef.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            ef.kickoff_at AS "kickoffAt", ef.status,
            ef.home_goals AS "homeGoals", ef.away_goals AS "awayGoals",
            ef.penalties
     FROM elite_cup_fixtures ef
     LEFT JOIN clubs hc ON hc.id = ef.home_club_id
     LEFT JOIN clubs ac ON ac.id = ef.away_club_id
     WHERE ef.id = $1`,
    [fixtureId],
  );
  return rows[0] || null;
}

async function listDueFixtures(limit = 10) {
  const { rows } = await query(
    `SELECT id, kickoff_at AS "kickoffAt" FROM elite_cup_fixtures
     WHERE status = 'scheduled' AND kickoff_at <= NOW()
       AND home_club_id IS NOT NULL AND away_club_id IS NOT NULL
     ORDER BY kickoff_at ASC LIMIT $1`,
    [limit],
  );
  return rows;
}

async function setFixtureLive(fixtureId, matchId) {
  await query(
    `UPDATE elite_cup_fixtures SET status = 'live', match_id = COALESCE($2, match_id)
     WHERE id = $1 AND status = 'scheduled'`,
    [fixtureId, matchId || null],
  );
}

async function applyMatchResult(fixtureId, homeGoals, awayGoals, matchId, penOpts) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM elite_cup_fixtures WHERE id = $1 FOR UPDATE`,
      [fixtureId],
    );
    const f = rows[0];
    if (!f) return { ok: false, error: "Fikstür yok" };
    if (f.status === "finished" || f.status === "bye") {
      return { ok: false, error: "Zaten bitmiş" };
    }

    const hg = Number(homeGoals);
    const ag = Number(awayGoals);
    let winner = null;
    let penalties = false;

    if (hg > ag) winner = f.home_club_id;
    else if (ag > hg) winner = f.away_club_id;
    else {
      penalties = true;
      const pre = penOpts || {};
      if (pre.penaltyWinner === "home" || pre.penaltyWinner === "away") {
        winner =
          pre.penaltyWinner === "home" ? f.home_club_id : f.away_club_id;
      } else {
        try {
          const { simulatePenaltyShootout } = require("../penaltyShootout");
          const sim = simulatePenaltyShootout({});
          winner =
            sim.winner === "home" ? f.home_club_id : f.away_club_id;
        } catch (_) {
          winner = Math.random() < 0.5 ? f.home_club_id : f.away_club_id;
        }
      }
    }

    await client.query(
      `UPDATE elite_cup_fixtures SET
         status = 'finished', home_goals = $2, away_goals = $3,
         winner_club_id = $4, penalties = $5,
         match_id = COALESCE($6, match_id)
       WHERE id = $1`,
      [fixtureId, hg, ag, winner, penalties, matchId || null],
    );


    try {
      const coeff = require("../countryCoefficient");
      let homeCountry = null, awayCountry = null;
      if (f.home_club_id) {
        const { rows: hc } = await client.query(`SELECT country FROM clubs WHERE id = $1`, [f.home_club_id]);
        homeCountry = hc[0] && hc[0].country;
      }
      if (f.away_club_id) {
        const { rows: ac } = await client.query(`SELECT country FROM clubs WHERE id = $1`, [f.away_club_id]);
        awayCountry = ac[0] && ac[0].country;
      }
      let winnerCountry = null;
      if (winner === f.home_club_id) winnerCountry = homeCountry;
      else if (winner === f.away_club_id) winnerCountry = awayCountry;
      await coeff.addMatchPoints("elite", {
        homeCountry, awayCountry, homeGoals: hg, awayGoals: ag,
        phase: String(f.round_label || f.round || ""),
        winnerCountry,
      });
    } catch (eC) {
      console.warn("[eliteCup] coeff", eC.message);
    }

    return {
      ok: true,
      editionId: f.edition_id,
      round: f.round,
      winnerClubId: winner,
      penalties,
    };
  });
}

async function advanceReadyEditions() {
  const ed = await getCurrentEdition();
  if (!ed) return { advanced: false };

  const { rows: open } = await query(
    `SELECT COUNT(*)::int AS c FROM elite_cup_fixtures
     WHERE edition_id = $1 AND round = $2
       AND status IN ('scheduled', 'live')`,
    [ed.id, ed.currentRound],
  );
  if (open[0] && open[0].c > 0) return { advanced: false };

  const { rows: winners } = await query(
    `SELECT winner_club_id FROM elite_cup_fixtures
     WHERE edition_id = $1 AND round = $2
       AND status IN ('finished', 'bye')
       AND winner_club_id IS NOT NULL
     ORDER BY slot ASC`,
    [ed.id, ed.currentRound],
  );
  const ids = winners.map((w) => w.winner_club_id).filter(Boolean);

  if (ids.length <= 1) {
    if (ids.length === 1) {
      const { rows: club } = await query(
        `SELECT name FROM clubs WHERE id = $1`,
        [ids[0]],
      );
      await query(
        `UPDATE elite_cup_editions SET
           is_current = FALSE,
           champion_club_id = $2,
           champion_name = $3
         WHERE id = $1`,
        [ed.id, ids[0], (club[0] && club[0].name) || "Şampiyon"],
      );
      try {
        const coeff = require("../countryCoefficient");
        const { rows: ch } = await query(`SELECT country FROM clubs WHERE id = $1`, [ids[0]]);
        if (ch[0] && ch[0].country) {
          await coeff.addMatchPoints("elite", {
            homeCountry: ch[0].country, awayCountry: null,
            homeGoals: 1, awayGoals: 0, phase: "final",
            winnerCountry: ch[0].country, isChampion: true,
          });
        }
        await coeff.recomputeTotalsAndSlots();
      } catch (e) {
        console.warn("[eliteCup] coeff finish", e.message);
      }
      return {
        advanced: true,
        phase: "finished",
        championClubId: ids[0],
        championName: (club[0] && club[0].name) || null,
      };
    }
    return { advanced: false, reason: "no_winners" };
  }

  const nextRound = ed.currentRound + 1;
  const label = roundLabel(nextRound, ed.totalRounds);
  // Sonraki tur: bir sonraki Çarşamba 15:00 TR
  const cal = require("../calendarSchedule");
  const startAt = cal.nextWednesday1500TR();
  const pairs = [];
  for (let i = 0; i < Math.floor(ids.length / 2); i++) {
    pairs.push([ids[i * 2], ids[i * 2 + 1]]);
  }
  const byeId = ids.length % 2 === 1 ? ids[ids.length - 1] : null;
  let slot = 0;
  const koIso = startAt.toISOString();

  for (let i = 0; i < pairs.length; i++) {
    await query(
      `INSERT INTO elite_cup_fixtures
         (edition_id, round, round_label, slot, home_club_id, away_club_id,
          kickoff_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
      [ed.id, nextRound, label, slot++, pairs[i][0], pairs[i][1], koIso],
    );
  }
  if (byeId) {
    await query(
      `INSERT INTO elite_cup_fixtures
         (edition_id, round, round_label, slot, home_club_id, away_club_id,
          status, winner_club_id)
       VALUES ($1, $2, $3, $4, $5, NULL, 'bye', $5)`,
      [ed.id, nextRound, label + " (bye)", slot++, byeId],
    );
  }

  await query(
    `UPDATE elite_cup_editions SET current_round = $2 WHERE id = $1`,
    [ed.id, nextRound],
  );

  return {
    advanced: true,
    phase: label,
    round: nextRound,
    pairs: pairs.length,
    byes: byeId ? 1 : 0,
  };
}

module.exports = {
  SEASON_WEEKS,
  getCurrentEdition,
  pickQualifiers,
  createEdition,
  getFixtures,
  getFixtureById,
  listDueFixtures,
  setFixtureLive,
  applyMatchResult,
  advanceReadyEditions,
};
