// ============================================================
// repos/continentalRepo.js — Kıtalar Ligi
// ============================================================

const { query, withTransaction } = require("../db");

// 16 grup × 4 takım = 64 (her ülkenin 1. Lig şampiyonu)
const CL_GROUP_SIZE = 4;
const CL_TARGET_GROUPS = 16;
const CL_GROUP_LETTERS = "ABCDEFGHIJKLMNOP"; // 16 harf (grp CHAR(1))

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
 * Her ülkenin 1. Lig lideri (şampiyon / sezon lideri) — ülke başına 1 kulüp.
 * Milli elemeler gibi: ülke temsilcileri gruplara serpilir.
 */
async function pickQualifiers() {
  // 3. sezon+: katsayı kontenjanı
  try {
    const coeff = require("../countryCoefficient");
    const mode = await coeff.getAccessMode();
    if (mode.mode === "coefficient") {
      const picked = await coeff.pickClubsBySlots("kitasal");
      if (picked.ok && picked.clubs.length >= 4) {
        let qualifiers = picked.clubs.map((c, i) => ({
          id: c.id,
          name: c.name,
          country: c.country,
          pts: c.pts || 0,
          gd: 0,
          countryRank: c.countryRank || i + 1,
        }));
        if (qualifiers.length > CL_TARGET_GROUPS * CL_GROUP_SIZE) {
          qualifiers = qualifiers.slice(0, CL_TARGET_GROUPS * CL_GROUP_SIZE);
        }
        const nKeep = Math.floor(qualifiers.length / CL_GROUP_SIZE) * CL_GROUP_SIZE;
        if (nKeep >= 4 && nKeep < qualifiers.length) qualifiers = qualifiers.slice(0, nKeep);
        const pot = (picked.pot || []).map((p) => ({
          country: p.country,
          pts: p.points,
          rank: p.rank,
          slots: p.kitasalSlots,
          clubName: null,
        }));
        return { pot, qualifiers, mode: "coefficient" };
      }
    }
  } catch (e) {
    console.warn("[continental] coeff pick", e.message);
  }

  // 2. sezon (fixed): kapanmış sezon şampiyonları
  // Kapanmış son 1. Lig sezonunun şampiyonu (1. sıra) — ülke başına 1
  const { rows: leaders } = await query(
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
     SELECT id, name, country, pts, gd, gf, "seasonLabel"
     FROM ranked
     WHERE rk = 1
     ORDER BY pts DESC, gd DESC, name ASC`,
  );

  let qualifiers = leaders.map((c, i) => ({
    id: c.id,
    name: c.name,
    country: c.country,
    pts: Number(c.pts) || 0,
    gd: Number(c.gd) || 0,
    countryRank: i + 1,
    seasonLabel: c.seasonLabel,
  }));

  if (qualifiers.length > CL_TARGET_GROUPS * CL_GROUP_SIZE) {
    qualifiers = qualifiers.slice(0, CL_TARGET_GROUPS * CL_GROUP_SIZE);
  }

  const nKeep =
    Math.floor(qualifiers.length / CL_GROUP_SIZE) * CL_GROUP_SIZE;
  if (nKeep >= 4 && nKeep < qualifiers.length) {
    qualifiers = qualifiers.slice(0, nKeep);
  }

  const pot = qualifiers.map((q, i) => ({
    country: q.country,
    pts: q.pts,
    rank: i + 1,
    slots: 1,
    clubName: q.name,
  }));

  return { pot, qualifiers };
}

/**
 * Milli kura benzeri: güç sırasına göre 4 torba, 16 (veya n/4) gruba serpme.
 * Grup etiketleri A–P (CHAR(1)).
 */
function splitGroups(qualifiers) {
  const sorted = (qualifiers || [])
    .slice()
    .sort((a, b) => (b.pts || 0) - (a.pts || 0) || (b.gd || 0) - (a.gd || 0));
  const n = sorted.length;
  let nGroups = Math.floor(n / CL_GROUP_SIZE);
  if (nGroups < 2) nGroups = Math.max(1, nGroups);
  if (nGroups > CL_TARGET_GROUPS) nGroups = CL_TARGET_GROUPS;

  const keys = [];
  for (let i = 0; i < nGroups; i++) {
    keys.push(CL_GROUP_LETTERS[i] || String(i));
  }

  // 4 torba
  const potSize = Math.ceil(n / 4) || 1;
  const pots = [[], [], [], []];
  sorted.forEach((q, i) => {
    const pot = Math.min(3, Math.floor(i / potSize));
    pots[pot].push(q);
  });
  // Torba içi karıştır
  pots.forEach((p) => {
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
  });

  const groups = {};
  keys.forEach((k) => {
    groups[k] = [];
  });
  for (let potIdx = 0; potIdx < 4; potIdx++) {
    for (let i = 0; i < pots[potIdx].length; i++) {
      const k = keys[i % nGroups];
      if (groups[k].length < CL_GROUP_SIZE) {
        groups[k].push(pots[potIdx][i]);
      }
    }
  }

  Object.keys(groups).forEach((k) => {
    if (!groups[k].length) delete groups[k];
  });
  return groups;
}

function groupFixtures(groupClubs) {
  const ids = groupClubs.map((c) => c.id);
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      pairs.push({ home: ids[i], away: ids[j] });
    }
  }
  return pairs;
}

// 9 haftalık sezon: grup 3 Çarşamba, eleme sonraki Çarşambalar — hepsi 15:00 TR
const CL_SEASON_WEEKS = 9;
const CL_SEASON_SPAN_MS = CL_SEASON_WEEKS * 7 * 24 * 3600 * 1000;

async function createEdition(yearLabel, opts = {}) {
  const cal = require("../calendarSchedule");
  const { pot, qualifiers } = await pickQualifiers();
  if (qualifiers.length < 4) {
    return {
      ok: false,
      error:
        "Yeterli 1. Lig şampiyonu yok (min 4 ülke, kapanmış sezon gerekli)",
      pot,
      qualifiers,
    };
  }

  const groups = splitGroups(qualifiers);
  const groupCount = Object.keys(groups).length;
  // Ortak slot: Çarşamba 15:00 TR (Elite Kupa ile aynı)
  const startAt =
    opts.startAt instanceof Date
      ? opts.startAt
      : cal.nextWednesday1500TR();

  return withTransaction(async (client) => {
    await client.query(
      `UPDATE continental_editions SET is_current = FALSE WHERE is_current = TRUE`,
    );
    const ins = await client.query(
      `INSERT INTO continental_editions (year_label, is_current, phase)
       VALUES ($1, TRUE, 'group')
       RETURNING id, year_label AS "yearLabel", phase`,
      [yearLabel || "KL-" + new Date().getFullYear()],
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

    // Grup: 3 maç günü = 3 ardışık Çarşamba 15:00 TR (tur içi tüm maçlar aynı saat)
    let slot = 0;
    for (const [grp, clubs] of Object.entries(groups)) {
      const pairs = groupFixtures(clubs);
      for (let pi = 0; pi < pairs.length; pi++) {
        const p = pairs[pi];
        const matchday = pi % 3;
        const ko = cal.wednesday1500TRPlusWeeks(startAt, matchday);
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
      qualifiers,
      groupCount,
      groups: Object.fromEntries(
        Object.entries(groups).map(([k, v]) => [
          k,
          v.map((c) => ({ id: c.id, name: c.name, country: c.country })),
        ]),
      ),
      fixtureCount: slot,
      startAt: startAt.toISOString(),
      kickoffSlot: "Çarşamba 15:00 TR",
      format: "kitasal_lig_16x4_group_winners",
      name: "Kıtasal Lig",
    };
  });
}

async function ensureEditionExists(yearLabel) {
  let ed = await getCurrentEdition();
  if (ed) return { edition: ed, created: false };

  // Bu sezon kilidi: 1. sezon bitmeden oluşturma
  try {
    const gate = require("../continentalGate");
    const can = await gate.canStartContinentalCompetitions();
    if (!can.ok) {
      return {
        edition: null,
        created: false,
        skipped: true,
        error: can.hint || can.reason,
      };
    }
  } catch (_) {}

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

/**
 * @param {object} [penOpts] matchEngine penaltı sonucu (opsiyonel)
 */
async function applyMatchResult(fixtureId, homeGoals, awayGoals, matchId, penOpts) {
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
    // Grupta beraberlik OK; elemede (qf/sf/final) 120' sonrası penaltı
    else if (f.phase !== "group") {
      penalties = true;
      const pre = penOpts || {};
      if (pre.penaltyWinner === "home" || pre.penaltyWinner === "away") {
        winner =
          pre.penaltyWinner === "home" ? f.home_club_id : f.away_club_id;
        if (pre.penaltyScore) {
          penHome = pre.penaltyScore.home;
          penAway = pre.penaltyScore.away;
        }
      } else {
        try {
          const { simulatePenaltyShootout } = require("../penaltyShootout");
          const sim = simulatePenaltyShootout({});
          winner =
            sim.winner === "home" ? f.home_club_id : f.away_club_id;
          penHome = sim.homeScore;
          penAway = sim.awayScore;
        } catch (_) {
          penHome = 0;
          penAway = 0;
          for (let i = 0; i < 5; i++) {
            if (Math.random() < 0.75) penHome++;
            if (Math.random() < 0.75) penAway++;
          }
          let guard = 0;
          while (penHome === penAway && guard < 12) {
            if (Math.random() < 0.72) penHome++;
            if (Math.random() < 0.72) penAway++;
            guard++;
          }
          if (penHome === penAway) penHome++;
          winner = penHome > penAway ? f.home_club_id : f.away_club_id;
        }
      }
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


    // Ülke katsayısı (2. sezon sonuçları → 3. sezon kontenjan)
    try {
      const coeff = require("../countryCoefficient");
      let homeCountry = null;
      let awayCountry = null;
      if (f.home_club_id) {
        const { rows: hc } = await client.query(
          `SELECT country FROM clubs WHERE id = $1`, [f.home_club_id],
        );
        homeCountry = hc[0] && hc[0].country;
      }
      if (f.away_club_id) {
        const { rows: ac } = await client.query(
          `SELECT country FROM clubs WHERE id = $1`, [f.away_club_id],
        );
        awayCountry = ac[0] && ac[0].country;
      }
      let winnerCountry = null;
      if (winner === f.home_club_id) winnerCountry = homeCountry;
      else if (winner === f.away_club_id) winnerCountry = awayCountry;
      await coeff.addMatchPoints("kitasal", {
        homeCountry,
        awayCountry,
        homeGoals: hg,
        awayGoals: ag,
        phase: f.phase,
        roundLabel: f.round_label,
        winnerCountry,
      });
    } catch (eC) {
      console.warn("[continental] coeff", eC.message);
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

function nextWednesdayKick(fromDate) {
  try {
    return require("../calendarSchedule").nextWednesday1500TR(fromDate);
  } catch (_) {
    let kick = fromDate ? new Date(fromDate) : new Date();
    kick.setUTCHours(12, 0, 0, 0);
    while (kick.getUTCDay() !== 3) {
      kick = new Date(kick.getTime() + 86400000);
    }
    if (kick.getTime() <= Date.now()) {
      kick = new Date(kick.getTime() + 7 * 86400000);
    }
    return kick;
  }
}

/** Bir sonraki eleme turu: bir sonraki Çarşamba 15:00 TR */
function nextKnockoutKick() {
  return nextWednesdayKick(new Date());
}

/** Tek maçlı eleme tur etiketleri (kalan takım sayısına göre). */
function knockoutPhaseForCount(n) {
  if (n <= 2) return { phase: "final", label: "Final", slotBase: 2000 };
  if (n <= 4) return { phase: "sf", label: "Yarı Final", slotBase: 1000 };
  if (n <= 8) return { phase: "qf", label: "Çeyrek Final", slotBase: 500 };
  return { phase: "r16", label: "Son 16", slotBase: 200 };
}

/**
 * Gruplar bitince: yalnızca grup liderleri (1.) üst tura.
 * 16 lider → Son 16 → ÇF → YF → Final (tek maçlı eleme, uzatma+penaltı).
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
     WHERE edition_id = $1 AND phase IN ('r16', 'qf', 'sf', 'final')`,
    [editionId],
  );
  if (existingKo[0] && existingKo[0].c > 0) {
    return maybeAdvanceKnockoutRound(editionId);
  }

  const standings = await getGroupStandings(editionId);
  const groupKeys = Object.keys(standings).sort();
  if (groupKeys.length < 2) return { advanced: false, reason: "need_2_groups" };

  // Yalnızca grup lideri (1.) — milli elemeler gibi
  const winners = [];
  for (const g of groupKeys) {
    const top = (standings[g] || [])[0];
    if (top && top.clubId) winners.push(top);
  }
  if (winners.length < 2) return { advanced: false, reason: "need_2_winners" };

  // Eşleştirme: 1–son, 2–sondan bir... (komşu gruplar)
  const ids = winners.map((w) => w.clubId);
  const pairs = [];
  for (let i = 0; i < Math.floor(ids.length / 2); i++) {
    pairs.push([ids[i], ids[ids.length - 1 - i]]);
  }
  // Tek kalan bye (kazanan olarak yaz)
  const byeId = ids.length % 2 === 1 ? ids[Math.floor(ids.length / 2)] : null;

  const meta = knockoutPhaseForCount(ids.length);
  // Tüm eleme maçları aynı slot: Çarşamba 15:00 TR
  const kick = nextKnockoutKick();
  let slot = meta.slotBase;

  for (let i = 0; i < pairs.length; i++) {
    const [h, a] = pairs[i];
    await query(
      `INSERT INTO continental_fixtures
         (edition_id, phase, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
      [editionId, meta.phase, meta.label, slot++, h, a, kick.toISOString()],
    );
  }
  if (byeId) {
    await query(
      `INSERT INTO continental_fixtures
         (edition_id, phase, round_label, slot, home_club_id, away_club_id, status, winner_club_id)
       VALUES ($1, $2, $3, $4, $5, NULL, 'finished', $5)`,
      [editionId, meta.phase, meta.label + " (bye)", slot++, byeId],
    );
  }

  await query(
    `UPDATE continental_editions SET phase = 'knockout' WHERE id = $1`,
    [editionId],
  );
  return {
    advanced: true,
    phase: meta.phase,
    pairs: pairs.length,
    byes: byeId ? 1 : 0,
    groupWinners: winners.length,
  };
}

/**
 * Mevcut eleme turu bitince bir sonraki tur (veya şampiyon).
 * Tur sırası: r16 → qf → sf → final → finished
 */
async function maybeAdvanceKnockoutRound(editionId) {
  const order = ["r16", "qf", "sf", "final"];
  for (let i = 0; i < order.length; i++) {
    const phase = order[i];
    const { rows: open } = await query(
      `SELECT COUNT(*)::int AS c FROM continental_fixtures
       WHERE edition_id = $1 AND phase = $2 AND status IN ('scheduled', 'live')`,
      [editionId, phase],
    );
    if (open[0] && open[0].c > 0) return { advanced: false };

    const { rows: phaseFx } = await query(
      `SELECT COUNT(*)::int AS c FROM continental_fixtures
       WHERE edition_id = $1 AND phase = $2`,
      [editionId, phase],
    );
    if (!phaseFx[0] || phaseFx[0].c === 0) continue;

    // Bu tur var ve tamamlanmış
    if (phase === "final") {
      return maybeFinishEdition(editionId);
    }

    // Sonraki tur zaten var mı?
    const nextPhases = order.slice(i + 1);
    let nextExists = false;
    for (const np of nextPhases) {
      const { rows: n } = await query(
        `SELECT COUNT(*)::int AS c FROM continental_fixtures
         WHERE edition_id = $1 AND phase = $2`,
        [editionId, np],
      );
      if (n[0] && n[0].c > 0) {
        nextExists = true;
        break;
      }
    }
    if (nextExists) continue;

    const { rows: winners } = await query(
      `SELECT winner_club_id FROM continental_fixtures
       WHERE edition_id = $1 AND phase = $2 AND status = 'finished'
         AND winner_club_id IS NOT NULL
       ORDER BY slot ASC`,
      [editionId, phase],
    );
    const ids = winners.map((w) => w.winner_club_id).filter(Boolean);
    if (ids.length < 2) {
      if (ids.length === 1) {
        // Tek kalan = şampiyon
        const { rows: club } = await query(
          `SELECT name FROM clubs WHERE id = $1`,
          [ids[0]],
        );
        await query(
          `UPDATE continental_editions SET
             phase = 'finished', is_current = FALSE,
             champion_club_id = $2, champion_name = $3
           WHERE id = $1`,
          [editionId, ids[0], (club[0] && club[0].name) || "Şampiyon"],
        );
        return { advanced: true, phase: "finished", championClubId: ids[0] };
      }
      return { advanced: false, reason: "need_winners" };
    }

    const meta = knockoutPhaseForCount(ids.length);
    const kick = nextKnockoutKick();
    const pairs = [];
    for (let p = 0; p < Math.floor(ids.length / 2); p++) {
      pairs.push([ids[p * 2], ids[p * 2 + 1]]);
    }
    const byeId = ids.length % 2 === 1 ? ids[ids.length - 1] : null;
    let slot = meta.slotBase;
    for (let p = 0; p < pairs.length; p++) {
      await query(
        `INSERT INTO continental_fixtures
           (edition_id, phase, round_label, slot, home_club_id, away_club_id, kickoff_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')`,
        [
          editionId,
          meta.phase,
          meta.label,
          slot++,
          pairs[p][0],
          pairs[p][1],
          kick.toISOString(),
        ],
      );
    }
    if (byeId) {
      await query(
        `INSERT INTO continental_fixtures
           (edition_id, phase, round_label, slot, home_club_id, away_club_id, status, winner_club_id)
         VALUES ($1, $2, $3, $4, $5, NULL, 'finished', $5)`,
        [editionId, meta.phase, meta.label + " (bye)", slot++, byeId],
      );
    }
    return { advanced: true, phase: meta.phase, pairs: pairs.length };
  }

  return maybeFinishEdition(editionId);
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
  try {
    const coeff = require("../countryCoefficient");
    const { rows: ch } = await query(
      `SELECT country FROM clubs WHERE id = $1`,
      [fin[0].winner_club_id],
    );
    if (ch[0] && ch[0].country) {
      await coeff.addMatchPoints("kitasal", {
        homeCountry: ch[0].country,
        awayCountry: null,
        homeGoals: 1,
        awayGoals: 0,
        phase: "final",
        winnerCountry: ch[0].country,
        isChampion: true,
      });
    }
    await coeff.recomputeTotalsAndSlots();
  } catch (e) {
    console.warn("[continental] coeff finish", e.message);
  }

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
