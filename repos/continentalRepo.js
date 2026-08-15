// ============================================================
// repos/continentalRepo.js — Kıtalar Ligi
// ============================================================

const { query, withTransaction } = require("../db");

const CL_SLOTS_BY_RANK = [4, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1];

function slotsForRank(rank) {
  const idx = Math.max(0, Number(rank) - 1);
  return idx < CL_SLOTS_BY_RANK.length ? CL_SLOTS_BY_RANK[idx] : 1;
}

async function getCurrentEdition() {
  const { rows } = await query(
    `SELECT id, year_label AS "yearLabel", is_current AS "isCurrent",
            phase, champion_club_id AS "championClubId",
            champion_name AS "championName", created_at AS "createdAt"
     FROM continental_editions
     WHERE is_current = TRUE
     ORDER BY id DESC LIMIT 1`,
  );
  return rows[0] || null;
}

/**
 * Ülke lig ranking'ine göre kontenjan + kulüp seçimi.
 * En az 8 kulüp hedeflenir.
 */
async function pickQualifiers(targetSize = 8) {
  // Ülke sıralaması: division 1 mevcut sezon ortalama puan / toplam puan
  const { rows: countryRows } = await query(
    `SELECT c.country,
            SUM(ls.pts)::int AS pts,
            COUNT(DISTINCT c.id)::int AS clubs
     FROM clubs c
     JOIN league_standings ls ON ls.club_id = c.id
     JOIN seasons s ON s.id = ls.season_id AND s.is_current = TRUE AND s.division = 1
     WHERE c.division = 1
     GROUP BY c.country
     ORDER BY SUM(ls.pts) DESC, COUNT(DISTINCT c.id) DESC, c.country ASC`,
  );

  let pot = countryRows.map((r, i) => ({
    country: r.country,
    pts: r.pts,
    clubs: r.clubs,
    rank: i + 1,
    slots: slotsForRank(i + 1),
  }));

  if (!pot.length) {
    // Fallback: herhangi division 1 kulüpleri
    const { rows: anyC } = await query(
      `SELECT country, COUNT(*)::int AS clubs FROM clubs
       WHERE division = 1 GROUP BY country ORDER BY COUNT(*) DESC`,
    );
    pot = anyC.map((r, i) => ({
      country: r.country,
      pts: 0,
      clubs: r.clubs,
      rank: i + 1,
      slots: slotsForRank(i + 1),
    }));
  }

  const qualifiers = [];
  for (const p of pot) {
    if (qualifiers.length >= targetSize) break;
    const need = Math.min(p.slots, targetSize - qualifiers.length);
    const { rows: clubs } = await query(
      `SELECT c.id, c.name, c.country, COALESCE(ls.pts, 0) AS pts
       FROM clubs c
       LEFT JOIN league_standings ls ON ls.club_id = c.id
       LEFT JOIN seasons s ON s.id = ls.season_id AND s.is_current = TRUE AND s.division = 1
       WHERE c.country = $1 AND c.division = 1
       ORDER BY COALESCE(ls.pts, 0) DESC, c.name ASC
       LIMIT $2`,
      [p.country, need],
    );
    for (const c of clubs) {
      if (qualifiers.length >= targetSize) break;
      if (qualifiers.some((q) => String(q.id) === String(c.id))) continue;
      qualifiers.push({
        id: c.id,
        name: c.name,
        country: c.country,
        pts: c.pts,
        countryRank: p.rank,
      });
    }
  }

  // Hâlâ eksikse herhangi kulüp
  if (qualifiers.length < Math.min(8, targetSize)) {
    const { rows: more } = await query(
      `SELECT id, name, country FROM clubs
       WHERE division = 1
       ORDER BY RANDOM() LIMIT $1`,
      [targetSize],
    );
    for (const c of more) {
      if (qualifiers.length >= targetSize) break;
      if (qualifiers.some((q) => String(q.id) === String(c.id))) continue;
      qualifiers.push({
        id: c.id,
        name: c.name,
        country: c.country,
        pts: 0,
        countryRank: 99,
      });
    }
  }

  return { pot, qualifiers };
}

function splitGroups(qualifiers) {
  // Snake draft into A/B (and C/D if 16)
  const groups = { A: [], B: [], C: [], D: [] };
  const keys =
    qualifiers.length >= 16
      ? ["A", "B", "C", "D"]
      : ["A", "B"];
  const sorted = qualifiers.slice().sort((a, b) => (b.pts || 0) - (a.pts || 0));
  sorted.forEach((q, i) => {
    const k = keys[i % keys.length];
    groups[k].push(q);
  });
  // Drop empty
  Object.keys(groups).forEach((k) => {
    if (!groups[k].length) delete groups[k];
  });
  return groups;
}

function groupFixtures(groupClubs) {
  // Single round-robin
  const ids = groupClubs.map((c) => c.id);
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push({ home: ids[i], away: ids[j] });
    }
  }
  return pairs;
}

async function createEdition(yearLabel, opts = {}) {
  const target = opts.targetSize || 8;
  const { pot, qualifiers } = await pickQualifiers(target);
  if (qualifiers.length < 4) {
    return { ok: false, error: "Yeterli kulüp yok (min 4)", pot, qualifiers };
  }

  // 8 veya 16'ya yuvarla
  let take = qualifiers.length >= 16 ? 16 : qualifiers.length >= 8 ? 8 : 4;
  const selected = qualifiers.slice(0, take);
  const groups = splitGroups(selected);

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE continental_editions SET is_current = FALSE WHERE is_current = TRUE`,
    );
    const ins = await client.query(
      `INSERT INTO continental_editions (year_label, is_current, phase)
       VALUES ($1, TRUE, 'group')
       RETURNING id, year_label AS "yearLabel", phase`,
      [yearLabel || "CL-" + new Date().getFullYear()],
    );
    const edition = ins.rows[0];

    for (const [grp, clubs] of Object.entries(groups)) {
      for (const c of clubs) {
        await client.query(
          `INSERT INTO continental_entries
             (edition_id, club_id, club_name, country, grp)
           VALUES ($1, $2, $3, $4, $5)`,
          [edition.id, c.id, c.name, c.country, grp],
        );
      }
    }

    // Kickoff: gelecek Çarşamba 15:00 TR (UTC+3) ≈ 12:00 UTC
    let kick = new Date();
    kick.setUTCHours(12, 0, 0, 0);
    while (kick.getUTCDay() !== 3) {
      kick = new Date(kick.getTime() + 86400000);
    }
    if (kick.getTime() < Date.now()) {
      kick = new Date(kick.getTime() + 7 * 86400000);
    }

    let slot = 0;
    for (const [grp, clubs] of Object.entries(groups)) {
      const pairs = groupFixtures(clubs);
      for (const p of pairs) {
        const ko = new Date(kick.getTime() + slot * 3 * 3600000);
        await client.query(
          `INSERT INTO continental_fixtures
             (edition_id, phase, round_label, grp, slot, home_club_id, away_club_id, kickoff_at, status)
           VALUES ($1, 'group', $2, $3, $4, $5, $6, $7, 'scheduled')`,
          [
            edition.id,
            "Grup " + grp,
            grp,
            slot,
            p.home,
            p.away,
            ko.toISOString(),
          ],
        );
        slot++;
      }
    }

    return {
      ok: true,
      edition,
      pot,
      qualifiers: selected,
      groups: Object.fromEntries(
        Object.entries(groups).map(([k, v]) => [
          k,
          v.map((c) => ({ id: c.id, name: c.name, country: c.country })),
        ]),
      ),
      fixtureCount: slot,
    };
  });
}

async function ensureEditionExists(yearLabel) {
  let ed = await getCurrentEdition();
  if (ed) return { edition: ed, created: false };
  const res = await createEdition(yearLabel);
  if (!res.ok) return { edition: null, created: false, error: res.error };
  return { edition: res.edition, created: true, ...res };
}

async function getGroupStandings(editionId) {
  const { rows } = await query(
    `SELECT club_id AS "clubId", club_name AS "clubName", country, grp,
            played, won, drawn, lost, gf, ga, pts,
            (gf - ga) AS gd
     FROM continental_entries
     WHERE edition_id = $1
     ORDER BY grp ASC, pts DESC, (gf - ga) DESC, gf DESC, club_name ASC`,
    [editionId],
  );
  const byGroup = {};
  for (const r of rows) {
    if (!byGroup[r.grp]) byGroup[r.grp] = [];
    byGroup[r.grp].push(r);
  }
  return byGroup;
}

async function getFixtures(editionId) {
  const { rows } = await query(
    `SELECT cf.id, cf.phase, cf.round_label AS "roundLabel", cf.grp, cf.slot,
            cf.home_club_id AS "homeClubId", cf.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            cf.kickoff_at AS "kickoffAt", cf.status,
            cf.home_goals AS "homeGoals", cf.away_goals AS "awayGoals",
            cf.winner_club_id AS "winnerClubId"
     FROM continental_fixtures cf
     LEFT JOIN clubs hc ON hc.id = cf.home_club_id
     LEFT JOIN clubs ac ON ac.id = cf.away_club_id
     WHERE cf.edition_id = $1
     ORDER BY cf.slot ASC, cf.kickoff_at ASC NULLS LAST`,
    [editionId],
  );
  return rows;
}

async function getFixtureById(fixtureId) {
  const { rows } = await query(
    `SELECT cf.id, cf.edition_id AS "editionId", cf.phase, cf.round_label AS "roundLabel",
            cf.home_club_id AS "homeClubId", cf.away_club_id AS "awayClubId",
            hc.name AS "homeName", ac.name AS "awayName",
            cf.kickoff_at AS "kickoffAt", cf.status,
            cf.home_goals AS "homeGoals", cf.away_goals AS "awayGoals"
     FROM continental_fixtures cf
     LEFT JOIN clubs hc ON hc.id = cf.home_club_id
     LEFT JOIN clubs ac ON ac.id = cf.away_club_id
     WHERE cf.id = $1`,
    [fixtureId],
  );
  return rows[0] || null;
}

async function listDueFixtures(limit = 10) {
  const { rows } = await query(
    `SELECT id, kickoff_at AS "kickoffAt" FROM continental_fixtures
     WHERE status = 'scheduled' AND kickoff_at <= NOW()
     ORDER BY kickoff_at ASC LIMIT $1`,
    [limit],
  );
  return rows;
}

async function setFixtureLive(fixtureId, matchId) {
  await query(
    `UPDATE continental_fixtures SET status = 'live', match_id = COALESCE($2, match_id)
     WHERE id = $1 AND status = 'scheduled'`,
    [fixtureId, matchId || null],
  );
}

async function applyMatchResult(fixtureId, homeGoals, awayGoals, matchId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM continental_fixtures WHERE id = $1 FOR UPDATE`,
      [fixtureId],
    );
    const f = rows[0];
    if (!f) return { ok: false, error: "Fikstür yok" };
    if (f.status === "finished") return { ok: false, error: "Zaten bitmiş" };

    const hg = Number(homeGoals);
    const ag = Number(awayGoals);
    let winner = null;
    let penalties = false;
    let penHome = null;
    let penAway = null;
    if (hg > ag) winner = f.home_club_id;
    else if (ag > hg) winner = f.away_club_id;
    // Grupta beraberlik OK; elemede 5'er penaltı simülasyonu
    else if (f.phase !== "group") {
      penalties = true;
      penHome = 0;
      penAway = 0;
      for (let i = 0; i < 5; i++) {
        if (Math.random() < 0.72) penHome++;
        if (Math.random() < 0.72) penAway++;
      }
      let guard = 0;
      while (penHome === penAway && guard < 10) {
        if (Math.random() < 0.7) penHome++;
        if (Math.random() < 0.7) penAway++;
        guard++;
      }
      if (penHome === penAway) penHome++;
      winner = penHome > penAway ? f.home_club_id : f.away_club_id;
    }

    await client.query(
      `UPDATE continental_fixtures SET
         status = 'finished', home_goals = $2, away_goals = $3,
         winner_club_id = $4, match_id = COALESCE($5, match_id)
       WHERE id = $1`,
      [fixtureId, hg, ag, winner, matchId || null],
    );

    if (f.phase === "group" && f.home_club_id && f.away_club_id) {
      const homePts = hg > ag ? 3 : hg === ag ? 1 : 0;
      const awayPts = ag > hg ? 3 : hg === ag ? 1 : 0;
      await client.query(
        `UPDATE continental_entries SET
           played = played + 1,
           won = won + CASE WHEN $3 > $4 THEN 1 ELSE 0 END,
           drawn = drawn + CASE WHEN $3 = $4 THEN 1 ELSE 0 END,
           lost = lost + CASE WHEN $3 < $4 THEN 1 ELSE 0 END,
           gf = gf + $3, ga = ga + $4, pts = pts + $5
         WHERE edition_id = $1 AND club_id = $2`,
        [f.edition_id, f.home_club_id, hg, ag, homePts],
      );
      await client.query(
        `UPDATE continental_entries SET
           played = played + 1,
           won = won + CASE WHEN $4 > $3 THEN 1 ELSE 0 END,
           drawn = drawn + CASE WHEN $3 = $4 THEN 1 ELSE 0 END,
           lost = lost + CASE WHEN $4 < $3 THEN 1 ELSE 0 END,
           gf = gf + $4, ga = ga + $3, pts = pts + $5
         WHERE edition_id = $1 AND club_id = $2`,
        [f.edition_id, f.away_club_id, hg, ag, awayPts],
      );
    }

    return {
      ok: true,
      editionId: f.edition_id,
      phase: f.phase,
      winnerClubId: winner,
      penalties,
      penHome,
      penAway,
    };
  });
}

/**
 * Gruplar bitince yarı final + final oluştur.
 */
async function maybeAdvanceKnockout(editionId) {
  const { rows: openGroup } = await query(
    `SELECT COUNT(*)::int AS c FROM continental_fixtures
     WHERE edition_id = $1 AND phase = 'group' AND status IN ('scheduled', 'live')`,
    [editionId],
  );
  if (openGroup[0] && openGroup[0].c > 0) return { advanced: false };

  const { rows: existingKo } = await query(
    `SELECT COUNT(*)::int AS c FROM continental_fixtures
     WHERE edition_id = $1 AND phase IN ('sf', 'final')`,
    [editionId],
  );
  if (existingKo[0] && existingKo[0].c > 0) {
    // SF bitti mi → final
    return maybeCreateFinal(editionId);
  }

  const standings = await getGroupStandings(editionId);
  const groupKeys = Object.keys(standings).sort();
  if (groupKeys.length < 2) return { advanced: false, reason: "need_2_groups" };

  // Her gruptan ilk 2
  const adv = [];
  for (const g of groupKeys) {
    const top = (standings[g] || []).slice(0, 2);
    adv.push(...top);
  }
  if (adv.length < 4) return { advanced: false, reason: "need_4" };

  // SF: A1 vs B2, B1 vs A2 (veya ilk 4 snake)
  const pairs =
    adv.length >= 4
      ? [
          [adv[0], adv[3]],
          [adv[1], adv[2]],
        ]
      : [];

  let kick = new Date();
  kick.setUTCHours(12, 0, 0, 0);
  while (kick.getUTCDay() !== 3) {
    kick = new Date(kick.getTime() + 86400000);
  }
  if (kick.getTime() < Date.now()) kick = new Date(kick.getTime() + 7 * 86400000);

  let slot = 1000;
  for (let i = 0; i < pairs.length; i++) {
    const [h, a] = pairs[i];
    const ko = new Date(kick.getTime() + i * 3 * 3600000);
    await query(
      `INSERT INTO continental_fixtures
         (edition_id, phase, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
       VALUES ($1, 'sf', 'Yarı Final', $2, $3, $4, $5, 'scheduled')`,
      [editionId, slot++, h.clubId, a.clubId, ko.toISOString()],
    );
  }
  await query(
    `UPDATE continental_editions SET phase = 'knockout' WHERE id = $1`,
    [editionId],
  );
  return { advanced: true, phase: "sf", pairs: pairs.length };
}

async function maybeCreateFinal(editionId) {
  const { rows: openSf } = await query(
    `SELECT COUNT(*)::int AS c FROM continental_fixtures
     WHERE edition_id = $1 AND phase = 'sf' AND status IN ('scheduled', 'live')`,
    [editionId],
  );
  if (openSf[0] && openSf[0].c > 0) return { advanced: false };

  const { rows: existingFinal } = await query(
    `SELECT COUNT(*)::int AS c FROM continental_fixtures
     WHERE edition_id = $1 AND phase = 'final'`,
    [editionId],
  );
  if (existingFinal[0] && existingFinal[0].c > 0) {
    return maybeFinishEdition(editionId);
  }

  const { rows: sf } = await query(
    `SELECT winner_club_id FROM continental_fixtures
     WHERE edition_id = $1 AND phase = 'sf' AND status = 'finished'
       AND winner_club_id IS NOT NULL
     ORDER BY slot ASC`,
    [editionId],
  );
  if (sf.length < 2) return { advanced: false, reason: "need_2_winners" };

  let kick = new Date(Date.now() + 7 * 86400000);
  kick.setUTCHours(12, 0, 0, 0);
  await query(
    `INSERT INTO continental_fixtures
       (edition_id, phase, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
     VALUES ($1, 'final', 'Final', 2000, $2, $3, $4, 'scheduled')`,
    [editionId, sf[0].winner_club_id, sf[1].winner_club_id, kick.toISOString()],
  );
  return { advanced: true, phase: "final" };
}

async function maybeFinishEdition(editionId) {
  const { rows: fin } = await query(
    `SELECT winner_club_id, status FROM continental_fixtures
     WHERE edition_id = $1 AND phase = 'final' ORDER BY slot DESC LIMIT 1`,
    [editionId],
  );
  if (!fin[0] || fin[0].status !== "finished" || !fin[0].winner_club_id) {
    return { advanced: false };
  }
  const { rows: club } = await query(
    `SELECT name FROM clubs WHERE id = $1`,
    [fin[0].winner_club_id],
  );
  await query(
    `UPDATE continental_editions SET
       phase = 'finished', is_current = FALSE,
       champion_club_id = $2, champion_name = $3
     WHERE id = $1`,
    [editionId, fin[0].winner_club_id, (club[0] && club[0].name) || "Şampiyon"],
  );
  return {
    advanced: true,
    phase: "finished",
    championClubId: fin[0].winner_club_id,
    championName: (club[0] && club[0].name) || null,
  };
}

module.exports = {
  getCurrentEdition,
  pickQualifiers,
  createEdition,
  ensureEditionExists,
  getGroupStandings,
  getFixtures,
  getFixtureById,
  listDueFixtures,
  setFixtureLive,
  applyMatchResult,
  maybeAdvanceKnockout,
};
