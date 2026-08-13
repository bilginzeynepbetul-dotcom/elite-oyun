// ============================================================
// repos/cupRepo.js — Kupa (tek eleme) sistemi
// ------------------------------------------------------------
// leagueRepo ile aynı desenler (query/withTransaction), ama tamamen
// ayrı tablolar (cup_editions, cup_fixtures) kullanır — lig kodunu
// hiç etkilemez.
// ============================================================

const { query, withTransaction } = require("../db");
const cal = require("../calendarSchedule");

// Demo/test varsayılanları (env ile prod aralıkları verilebilir)
const FIRST_ROUND_OFFSET_MS = Number(process.env.CUP_FIRST_ROUND_OFFSET_MS) || 3 * 60 * 1000;
// Grup maçları arası (lig haftasıyla uyumlu ~ birkaç gün / testte kısa)
const GROUP_MATCH_SPACING_MS = Number(process.env.CUP_GROUP_MATCH_SPACING_MS) || 6 * 60 * 60 * 1000;
// Eleme turları arası — final aşaması daha sık
const KNOCKOUT_ROUND_GAP_MS = Number(process.env.CUP_KNOCKOUT_ROUND_GAP_MS) || 2 * 24 * 60 * 60 * 1000;
const MATCH_SPACING_MS = Number(process.env.CUP_MATCH_SPACING_MS) || 2 * 60 * 1000;
// Geriye uyumluluk
const ROUND_GAP_MS = KNOCKOUT_ROUND_GAP_MS;
const GROUP_SIZE = 4;

/**
 * Ülke kupa slotlarına göre (yerel uyku saatine düşmeyen) N adet kickoff.
 * Calendar yoksa eski spacing fallback.
 */
function cupKickoffsForCountry(country, count, fromDate) {
  const start = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());
  try {
    const slots =
      typeof cal.cupSlotsForCountry === "function"
        ? cal.cupSlotsForCountry(country)
        : typeof cal.slotsForCountry === "function"
          ? cal.slotsForCountry(country)
          : null;
    if (slots && slots.length && typeof cal.generateKickoffSequence === "function") {
      const seq = cal.generateKickoffSequence(start, count, slots);
      if (seq && seq.length >= count) return seq;
      if (seq && seq.length) {
        // eksikleri spacing ile doldur
        const out = seq.slice();
        let last = out[out.length - 1].getTime();
        while (out.length < count) {
          last += GROUP_MATCH_SPACING_MS;
          out.push(new Date(last));
        }
        return out;
      }
    }
  } catch (_) {}
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(start.getTime() + i * GROUP_MATCH_SPACING_MS));
  }
  return out;
}

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
    const shuffled = shuffle(clubIds);
    const useGroups = shuffled.length >= 8 && opts.forceKnockoutOnly !== true;

    if (!useGroups) {
      // Az kulüp: klasik tek eleme
      const totalRounds = roundsForSize(shuffled.length);
      const { rows: edRows } = await client.query(
        `INSERT INTO cup_editions (country, year_label, is_current, current_round, total_rounds)
         VALUES ($1, $2, TRUE, 1, $3)
         ON CONFLICT (country, year_label) DO UPDATE SET is_current = TRUE, current_round = 1, total_rounds = $3
         RETURNING id`,
        [country, yearLabel, totalRounds],
      );
      const editionId = edRows[0].id;
      const startAt = opts.startAt || new Date(Date.now() + FIRST_ROUND_OFFSET_MS);
      const pairs = [];
      for (let i = 0; i < shuffled.length; i += 2) {
        pairs.push([shuffled[i], shuffled[i + 1] || null]);
      }
      const matchCount = pairs.filter((p) => p[1]).length;
      const koKickoffs = cupKickoffsForCountry(country, matchCount, startAt);
      let slot = 0;
      let ki = 0;
      for (const [home, away] of pairs) {
        if (!away) {
          await client.query(
            `INSERT INTO cup_fixtures
               (edition_id, round, round_label, slot, home_club_id, away_club_id,
                status, winner_club_id)
             VALUES ($1, 1, $2, $3, $4, NULL, 'bye', $4)`,
            [editionId, roundLabel(1, totalRounds), slot, home],
          );
        } else {
          const kickoff =
            koKickoffs[ki++] ||
            new Date(startAt.getTime() + slot * MATCH_SPACING_MS);
          await client.query(
            `INSERT INTO cup_fixtures
               (edition_id, round, round_label, slot, home_club_id, away_club_id,
                kickoff_at, status)
             VALUES ($1, 1, $2, $3, $4, $5, $6, 'scheduled')`,
            [
              editionId,
              roundLabel(1, totalRounds),
              slot,
              home,
              away,
              kickoff.toISOString(),
            ],
          );
        }
        slot++;
      }
      return {
        ok: true,
        editionId,
        totalRounds,
        phase: "knockout",
        pairsCreated: pairs.length,
      };
    }

    // ---- Grup aşaması + eleme (Son 16 / ÇF / YF / Final) ----
    // Gruplar: 4'lü; fazla takım en yakın 4'ün katına kadar (fazlalar bye grubuna değil, en küçük gruplara eklenmez — kesilir)
    const nGroups = Math.max(2, Math.floor(shuffled.length / GROUP_SIZE));
    const used = shuffled.slice(0, nGroups * GROUP_SIZE);
    const groups = [];
    for (let g = 0; g < nGroups; g++) {
      groups.push(used.slice(g * GROUP_SIZE, (g + 1) * GROUP_SIZE));
    }
    // Eleme turu sayısı: nGroups*2 (her gruptan 2) → 2^k
    const knockoutTeams = nGroups * 2;
    const koRounds = roundsForSize(knockoutTeams);
    // total_rounds = 1 (grup) + koRounds
    const totalRounds = 1 + koRounds;

    const { rows: edRows } = await client.query(
      `INSERT INTO cup_editions (country, year_label, is_current, current_round, total_rounds)
       VALUES ($1, $2, TRUE, 1, $3)
       ON CONFLICT (country, year_label) DO UPDATE
         SET is_current = TRUE, current_round = 1, total_rounds = $3, champion_club_id = NULL
       RETURNING id`,
      [country, yearLabel, totalRounds],
    );
    const editionId = edRows[0].id;
    const startAt = opts.startAt || new Date(Date.now() + FIRST_ROUND_OFFSET_MS);

    // Her grupta tek devreli (herkes herkese 1 maç): 4 takım → 6 maç
    // Kickoff'lar ülke yerel uyanık saatlerine göre (uyku 00–09 yerel yok)
    let totalGroupMatches = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      totalGroupMatches += (g.length * (g.length - 1)) / 2;
    }
    const groupKickoffs = cupKickoffsForCountry(
      country,
      totalGroupMatches,
      startAt,
    );
    let globalSlot = 0;
    let matchIndex = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const label = "Grup " + String.fromCharCode(65 + gi); // A, B, C...
      const g = groups[gi];
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const home = g[i];
          const away = g[j];
          const kickoff =
            groupKickoffs[matchIndex] ||
            new Date(startAt.getTime() + matchIndex * GROUP_MATCH_SPACING_MS);
          await client.query(
            `INSERT INTO cup_fixtures
               (edition_id, round, round_label, slot, home_club_id, away_club_id,
                kickoff_at, status)
             VALUES ($1, 1, $2, $3, $4, $5, $6, 'scheduled')`,
            [editionId, label, globalSlot, home, away, kickoff.toISOString()],
          );
          globalSlot++;
          matchIndex++;
        }
      }
    }

    return {
      ok: true,
      editionId,
      totalRounds,
      phase: "group",
      groups: nGroups,
      knockoutTeams,
      groupMatches: matchIndex,
    };
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
async function leagueSeasonEndAt(country) {
  const { rows } = await query(
    `SELECT MAX(f.kickoff_at) AS last_kickoff
     FROM fixtures f
     JOIN seasons s ON s.id = f.season_id
     WHERE s.country = $1 AND s.is_current = TRUE`,
    [country],
  );
  if (rows[0] && rows[0].last_kickoff) return new Date(rows[0].last_kickoff);
  return null;
}

/** Grup maçlarından puan tablosu → her gruptan ilk 2 */
function groupQualifiers(groupFixtures) {
  // groupFixtures: [{roundLabel, homeClubId, awayClubId, homeGoals, awayGoals, winnerClubId, status}]
  const byGroup = new Map();
  for (const f of groupFixtures) {
    const label = f.roundLabel || f.round_label || "Grup";
    if (!byGroup.has(label)) byGroup.set(label, []);
    byGroup.get(label).push(f);
  }
  const qualified = [];
  for (const [label, matches] of byGroup.entries()) {
    const table = new Map(); // clubId -> {pts, gd, gf}
    const touch = (id) => {
      if (!table.has(id)) table.set(id, { clubId: id, pts: 0, gd: 0, gf: 0 });
      return table.get(id);
    };
    for (const m of matches) {
      if (m.status !== "finished" && m.status !== "bye") continue;
      const h = m.homeClubId || m.home_club_id;
      const a = m.awayClubId || m.away_club_id;
      if (!h || !a) continue;
      const hg = Number(m.homeGoals != null ? m.homeGoals : m.home_goals) || 0;
      const ag = Number(m.awayGoals != null ? m.awayGoals : m.away_goals) || 0;
      const H = touch(h);
      const A = touch(a);
      H.gf += hg; A.gf += ag;
      H.gd += hg - ag; A.gd += ag - hg;
      if (hg > ag) H.pts += 3;
      else if (ag > hg) A.pts += 3;
      else { H.pts += 1; A.pts += 1; }
    }
    const ranked = Array.from(table.values()).sort((x, y) => {
      if (y.pts !== x.pts) return y.pts - x.pts;
      if (y.gd !== x.gd) return y.gd - x.gd;
      return y.gf - x.gf;
    });
    // İlk 2
    for (const row of ranked.slice(0, 2)) qualified.push(row.clubId);
  }
  return qualified;
}

/**
 * Her is_current edition için: mevcut tur bitmiş mi?
 * Grup aşaması bittiyse eleme bracket'ini sezon bitişinden sonraya kurar.
 * Eleme turu bittiyse bir sonraki turu (daha sık aralıkla) açar veya şampiyon ilan eder.
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
      if (pending[0].c > 0) continue;

      // Grup aşaması mı? (round_label Grup *)
      const { rows: sample } = await query(
        `SELECT round_label AS "roundLabel" FROM cup_fixtures
         WHERE edition_id = $1 AND round = $2 LIMIT 1`,
        [ed.id, ed.currentRound],
      );
      const isGroupPhase =
        sample[0] &&
        String(sample[0].roundLabel || "").toLowerCase().startsWith("grup");

      if (isGroupPhase) {
        const { rows: groupFx } = await query(
          `SELECT round_label AS "roundLabel",
                  home_club_id AS "homeClubId", away_club_id AS "awayClubId",
                  home_goals AS "homeGoals", away_goals AS "awayGoals",
                  winner_club_id AS "winnerClubId", status
           FROM cup_fixtures WHERE edition_id = $1 AND round = $2`,
          [ed.id, ed.currentRound],
        );
        let winnerIds = groupQualifiers(groupFx);
        // Güç-of-2'ye yuvarla (fazla ise en sondan kes)
        while (winnerIds.length > 1 && (winnerIds.length & (winnerIds.length - 1)) !== 0) {
          winnerIds = winnerIds.slice(0, winnerIds.length - 1);
        }
        if (winnerIds.length < 2) {
          // Yetersiz — şampiyon yok, edition kapat
          await query(
            `UPDATE cup_editions SET is_current = FALSE WHERE id = $1`,
            [ed.id],
          );
          advanced.push({ editionId: ed.id, phase: "group_failed" });
          continue;
        }

        // Eleme kickoff: lig sezonunun son maçından sonra (yoksa şimdi + gap)
        const seasonEnd = await leagueSeasonEndAt(ed.country);
        let startAt;
        if (seasonEnd && seasonEnd.getTime() > Date.now()) {
          startAt = new Date(seasonEnd.getTime() + KNOCKOUT_ROUND_GAP_MS);
        } else {
          startAt = new Date(Date.now() + KNOCKOUT_ROUND_GAP_MS);
        }

        const nextRound = ed.currentRound + 1;
        const koTotal = roundsForSize(winnerIds.length);
        // total_rounds = current group (1) + ko rounds
        const newTotal = ed.currentRound + koTotal;
        const label = roundLabel(1, koTotal); // Son 16 / ÇF ... relative to ko bracket
        // Fix labels for absolute round numbers
        const absLabel = roundLabel(nextRound - ed.currentRound, koTotal);

        const pairCount = Math.ceil(winnerIds.length / 2);
        const koKickoffs = cupKickoffsForCountry(
          ed.country,
          pairCount,
          startAt,
        );
        let slot = 0;
        let ki = 0;
        for (let i = 0; i < winnerIds.length; i += 2) {
          const home = winnerIds[i];
          const away = winnerIds[i + 1] || null;
          if (!away) {
            await query(
              `INSERT INTO cup_fixtures
                 (edition_id, round, round_label, slot, home_club_id, away_club_id, status, winner_club_id)
               VALUES ($1, $2, $3, $4, $5, NULL, 'bye', $5)`,
              [ed.id, nextRound, absLabel, slot, home],
            );
          } else {
            const kickoff =
              koKickoffs[ki++] ||
              new Date(startAt.getTime() + slot * MATCH_SPACING_MS);
            await query(
              `INSERT INTO cup_fixtures
                 (edition_id, round, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
              [ed.id, nextRound, absLabel, slot, home, away, kickoff.toISOString()],
            );
          }
          slot++;
        }
        await query(
          `UPDATE cup_editions SET current_round = $2, total_rounds = $3 WHERE id = $1`,
          [ed.id, nextRound, newTotal],
        );
        advanced.push({
          editionId: ed.id,
          phase: "knockout_seeded",
          nextRound,
          qualifiers: winnerIds.length,
          startAt: startAt.toISOString(),
        });
        continue;
      }

      // Klasik eleme turu ilerlemesi
      const { rows: winners } = await query(
        `SELECT slot, winner_club_id AS "winnerClubId"
         FROM cup_fixtures WHERE edition_id = $1 AND round = $2 ORDER BY slot ASC`,
        [ed.id, ed.currentRound],
      );
      if (!winners.length) continue;
      const winnerIds = winners.map((w) => w.winnerClubId).filter(Boolean);

      if (winnerIds.length <= 1) {
        await query(
          `UPDATE cup_editions SET is_current = FALSE, champion_club_id = $2 WHERE id = $1`,
          [ed.id, winnerIds[0] || null],
        );
        advanced.push({ editionId: ed.id, champion: winnerIds[0] || null });
        continue;
      }

      const nextRound = ed.currentRound + 1;
      const remainingRounds = Math.max(1, ed.totalRounds - ed.currentRound);
      const label = roundLabel(1, remainingRounds);
      const startAt = new Date(Date.now() + KNOCKOUT_ROUND_GAP_MS);
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
