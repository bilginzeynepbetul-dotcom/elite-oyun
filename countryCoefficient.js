// ============================================================
// countryCoefficient.js — Ülke torbası / katsayı
// ------------------------------------------------------------
// Kıtasal Lig + Elite Kupa sonuçlarından puan.
// 2. sezonda toplanır → 3. sezondan kontenjan dağılımı.
//
// Puan (maç başı, ülkeye yazılır):
//   Galibiyet 2, beraberlik 1 (grup)
//   Eleme galibiyeti 2
//   Tur bonus: R16 +1, QF +2, SF +3, Final +4, Şampiyon +6
//
// Kontenjan (64 ülke): Kıtasal 64 + Elite 128
//   1–8   → 3 KL + 4 EK = 7  → KL 24, EK 32
//   9–16  → 2 KL + 3 EK = 5  → KL 16, EK 24
//   17–40 → 1 KL + 2 EK = 3  → KL 24, EK 48
//   41–64 → 0 KL + 1 EK = 1  → KL  0, EK 24
//   Toplam: KL 64, EK 128
// ============================================================

const { query } = require("./db");

const PTS_WIN = 2;
const PTS_DRAW = 1;
const BONUS = {
  r16: 1,
  qf: 2,
  sf: 3,
  final: 4,
  champion: 6,
};

const TARGET_KITASAL = 64; // 16 grup × 4
const TARGET_ELITE = 128;

/** Sıra → kontenjan (KL 64 + EK 128) */
function slotsForRank(rank) {
  const r = Math.max(1, Number(rank) || 99);
  if (r <= 8) return { kitasal: 3, elite: 4, total: 7 };
  if (r <= 16) return { kitasal: 2, elite: 3, total: 5 };
  if (r <= 40) return { kitasal: 1, elite: 2, total: 3 };
  // Zayıf ülke: yalnızca Elite Kupa (1 takım)
  return { kitasal: 0, elite: 1, total: 1 };
}

function currentCoeffSeasonLabel() {
  const y = new Date().getFullYear();
  return "CC-" + y;
}

async function ensureRow(country, seasonLabel) {
  const c = String(country || "").trim();
  if (!c) return;
  const label = seasonLabel || currentCoeffSeasonLabel();
  await query(
    `INSERT INTO country_coefficients (country, season_label, points)
     VALUES ($1, $2, 0)
     ON CONFLICT (country, season_label) DO NOTHING`,
    [c, label],
  );
}

/**
 * Maç sonucu puanı (ülke bazlı).
 * @param {'kitasal'|'elite'} competition
 * @param {object} opts { homeCountry, awayCountry, homeGoals, awayGoals, phase, isChampion? }
 */
async function addMatchPoints(competition, opts) {
  const label = opts.seasonLabel || currentCoeffSeasonLabel();
  const hg = Number(opts.homeGoals) || 0;
  const ag = Number(opts.awayGoals) || 0;
  const phase = String(opts.phase || opts.roundLabel || "group").toLowerCase();
  const isGroup = phase === "group" || phase.includes("grup");

  async function award(country, pts, winInc, playedInc) {
    if (!country || pts <= 0 && !playedInc) return;
    await ensureRow(country, label);
    const colPlay = competition === "elite" ? "ek_played" : "kl_played";
    const colWin = competition === "elite" ? "ek_wins" : "kl_wins";
    await query(
      `UPDATE country_coefficients SET
         points = points + $3,
         ${colPlay} = ${colPlay} + $4,
         ${colWin} = ${colWin} + $5,
         updated_at = NOW()
       WHERE country = $1 AND season_label = $2`,
      [country, label, pts, playedInc, winInc],
    );
  }

  // Oynanan maç
  let homePts = 0;
  let awayPts = 0;
  let homeWin = 0;
  let awayWin = 0;
  if (hg > ag) {
    homePts = PTS_WIN;
    homeWin = 1;
    if (isGroup) awayPts = 0;
  } else if (ag > hg) {
    awayPts = PTS_WIN;
    awayWin = 1;
  } else if (isGroup) {
    homePts = PTS_DRAW;
    awayPts = PTS_DRAW;
  }
  // Elemede beraberlik olmaz (penaltı sonrası kazanan zaten gol farkı veya winner ile gelir)

  await award(opts.homeCountry, homePts, homeWin, 1);
  await award(opts.awayCountry, awayPts, awayWin, 1);

  // Tur bonus (kazanan ülkeye)
  const winnerCountry =
    opts.winnerCountry ||
    (hg > ag ? opts.homeCountry : ag > hg ? opts.awayCountry : null);
  if (winnerCountry && !isGroup) {
    let bonus = 0;
    if (phase.includes("16") || phase === "r16") bonus = BONUS.r16;
    else if (phase.includes("çeyrek") || phase === "qf") bonus = BONUS.qf;
    else if (phase.includes("yarı") || phase === "sf") bonus = BONUS.sf;
    else if (phase.includes("final") && !opts.isChampion) bonus = BONUS.final;
    if (opts.isChampion) bonus = BONUS.champion;
    if (bonus > 0) {
      await ensureRow(winnerCountry, label);
      await query(
        `UPDATE country_coefficients SET
           points = points + $3,
           best_finish = COALESCE($4, best_finish),
           updated_at = NOW()
         WHERE country = $1 AND season_label = $2`,
        [
          winnerCountry,
          label,
          bonus,
          opts.isChampion
            ? competition === "elite"
              ? "ek_champion"
              : "kl_champion"
            : phase,
        ],
      );
    }
  }

  return true;
}

/** Tüm ülkelerin sezon puanını topla → totals + rank + slots */
async function recomputeTotalsAndSlots(seasonLabel) {
  // Son 2 katsayı sezonunu topla (yoksa tek sezon)
  const { rows: seasons } = await query(
    `SELECT DISTINCT season_label FROM country_coefficients
     ORDER BY season_label DESC LIMIT 2`,
  );
  const labels = (seasons || []).map((r) => r.season_label);
  if (seasonLabel && !labels.includes(seasonLabel)) labels.unshift(seasonLabel);
  if (!labels.length) labels.push(currentCoeffSeasonLabel());

  const { rows } = await query(
    `SELECT country, SUM(points)::float AS total
     FROM country_coefficients
     WHERE season_label = ANY($1::text[])
     GROUP BY country
     ORDER BY SUM(points) DESC, country ASC`,
    [labels],
  );

  // Desteklenen ülkeleri de ekle (0 puan)
  let allCountries = rows.map((r) => r.country);
  try {
    const { SUPPORTED_COUNTRIES } = require("./countries");
    for (const c of SUPPORTED_COUNTRIES || []) {
      if (!allCountries.includes(c)) allCountries.push(c);
    }
  } catch (_) {}

  const byPts = {};
  rows.forEach((r) => {
    byPts[r.country] = Number(r.total) || 0;
  });

  const ranked = allCountries
    .map((c) => ({ country: c, total: byPts[c] || 0 }))
    .sort((a, b) => b.total - a.total || a.country.localeCompare(b.country, "tr"));

  // Ham kontenjan
  let pot = ranked.map((row, i) => {
    const rank = i + 1;
    const s = slotsForRank(rank);
    return {
      country: row.country,
      rank,
      points: row.total,
      kitasalSlots: s.kitasal,
      eliteSlots: s.elite,
      totalSlots: s.total,
    };
  });

  // Kıtasal → 64, Elite → 128 (ülke sayısı farklıysa dengele)
  function balance(field, target, maxPerCountry) {
    let sum = pot.reduce((s, p) => s + p[field], 0);
    if (sum < target) {
      let i = 0;
      while (sum < target && pot.length) {
        const p = pot[i % pot.length];
        if (p[field] < maxPerCountry) {
          p[field]++;
          p.totalSlots = p.kitasalSlots + p.eliteSlots;
          sum++;
        }
        i++;
        if (i > pot.length * 12) break;
      }
    } else if (sum > target) {
      for (let i = pot.length - 1; i >= 0 && sum > target; i--) {
        // Elite'de en az 1 bırak (zayıf ülke de 1 EK alsın)
        const minKeep = field === "eliteSlots" ? 1 : 0;
        if (pot[i][field] > minKeep) {
          pot[i][field]--;
          pot[i].totalSlots = pot[i].kitasalSlots + pot[i].eliteSlots;
          sum--;
        }
      }
    }
  }
  balance("kitasalSlots", TARGET_KITASAL, 4);
  balance("eliteSlots", TARGET_ELITE, 5);
  pot.forEach((p) => {
    p.totalSlots = p.kitasalSlots + p.eliteSlots;
  });

  for (const p of pot) {
    await query(
      `INSERT INTO country_coefficient_totals
         (country, total_points, rank, kitasal_slots, elite_slots, total_slots, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (country) DO UPDATE SET
         total_points = EXCLUDED.total_points,
         rank = EXCLUDED.rank,
         kitasal_slots = EXCLUDED.kitasal_slots,
         elite_slots = EXCLUDED.elite_slots,
         total_slots = EXCLUDED.total_slots,
         updated_at = NOW()`,
      [
        p.country,
        p.points,
        p.rank,
        p.kitasalSlots,
        p.eliteSlots,
        p.totalSlots,
      ],
    );
  }

  // game_settings yedek (UI)
  try {
    await query(
      `INSERT INTO game_settings (key, value, updated_at)
       VALUES ('country_coefficient_pot', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ updatedAt: new Date().toISOString(), pot })],
    );
  } catch (_) {}

  return { pot, seasonLabels: labels };
}

async function getPot() {
  const { rows } = await query(
    `SELECT country, total_points AS points, rank,
            kitasal_slots AS "kitasalSlots",
            elite_slots AS "eliteSlots",
            total_slots AS "totalSlots"
     FROM country_coefficient_totals
     ORDER BY rank ASC NULLS LAST, total_points DESC`,
  );
  if (rows.length) return rows;
  // Boşsa varsayılan: her ülke 1 Elite
  try {
    const { SUPPORTED_COUNTRIES } = require("./countries");
    return (SUPPORTED_COUNTRIES || []).map((c, i) => ({
      country: c,
      points: 0,
      rank: i + 1,
      kitasalSlots: 0,
      eliteSlots: 1,
      totalSlots: 1,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Erişim modu:
 *  - none: henüz 1. sezon bitmedi
 *  - fixed_s2: şampiyon → Kıtasal, 2.+3. → Elite (katsayı yok / yetersiz)
 *  - coefficient: 3. sezon+ torba kontenjanı
 */
async function getAccessMode() {
  const { rows: closed } = await query(
    `SELECT COUNT(DISTINCT year_label)::int AS labels,
            COUNT(DISTINCT country)::int AS countries
     FROM seasons WHERE division = 1 AND is_current = FALSE`,
  );
  const labels = (closed[0] && closed[0].labels) || 0;
  const countries = (closed[0] && closed[0].countries) || 0;
  if (labels < 1 || countries < 8) {
    return { mode: "none", labels, countries };
  }

  const { rows: coeff } = await query(
    `SELECT COUNT(*)::int AS c FROM country_coefficient_totals WHERE total_points > 0`,
  );
  const hasPoints = (coeff[0] && coeff[0].c) || 0;

  // En az 2 kapalı lig sezonu etiketi VE katsayı puanı birikmişse 3. sezon modeli
  if (labels >= 2 && hasPoints >= 4) {
    return { mode: "coefficient", labels, countries, hasPoints };
  }
  return { mode: "fixed_s2", labels, countries, hasPoints };
}

/**
 * Kontenjana göre 1. Lig sıralamasından kulüp seç.
 * @param {'kitasal'|'elite'} competition
 */
async function pickClubsBySlots(competition) {
  const pot = await getPot();
  const mode = await getAccessMode();
  if (mode.mode !== "coefficient") {
    return { ok: false, reason: mode.mode, clubs: [] };
  }

  const clubs = [];
  for (const row of pot) {
    const need =
      competition === "kitasal"
        ? Number(row.kitasalSlots) || 0
        : Number(row.eliteSlots) || 0;
    if (need <= 0) continue;

    // Kapanmış son 1. Lig sezonu sıralaması
    const { rows: ranked } = await query(
      `WITH last_season AS (
         SELECT id FROM seasons
         WHERE country = $1 AND division = 1 AND is_current = FALSE
         ORDER BY id DESC LIMIT 1
       ),
       ranked AS (
         SELECT c.id, c.name, c.country, COALESCE(ls.pts, 0) AS pts,
                ROW_NUMBER() OVER (
                  ORDER BY COALESCE(ls.pts, 0) DESC,
                           (COALESCE(ls.gf, 0) - COALESCE(ls.ga, 0)) DESC,
                           COALESCE(ls.gf, 0) DESC, c.name ASC
                ) AS rk
         FROM last_season s
         JOIN league_standings ls ON ls.season_id = s.id
         JOIN clubs c ON c.id = ls.club_id
       )
       SELECT id, name, country, pts, rk FROM ranked
       ORDER BY rk ASC LIMIT $2`,
      [row.country, need + 4],
    );

    // Kıtasal slotlar: lig 1..kitasal
    // Elite slotlar: Kıtasal'a gidenleri atla, sonraki sıralar
    let taken = 0;
    const skip =
      competition === "elite" ? Number(row.kitasalSlots) || 0 : 0;
    for (const c of ranked) {
      if (c.rk <= skip) continue;
      if (taken >= need) break;
      if (clubs.some((x) => String(x.id) === String(c.id))) continue;
      clubs.push({
        id: c.id,
        name: c.name,
        country: c.country,
        pts: Number(c.pts) || 0,
        domesticRank: Number(c.rk),
        countryRank: row.rank,
        countryPoints: row.points,
        slotSource: competition,
      });
      taken++;
    }
  }

  return { ok: true, clubs, pot, mode };
}

module.exports = {
  PTS_WIN,
  PTS_DRAW,
  BONUS,
  slotsForRank,
  currentCoeffSeasonLabel,
  addMatchPoints,
  recomputeTotalsAndSlots,
  getPot,
  getAccessMode,
  pickClubsBySlots,
};
