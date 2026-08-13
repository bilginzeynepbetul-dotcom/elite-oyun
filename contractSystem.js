// ============================================================
// contractSystem.js — Oyuncu maaşı, sözleşme, bordro
// ------------------------------------------------------------
// configure({ getClub, adjustBalance, getTeam, saveTeam, ... })
// veya doğrudan DB (repos) ile çalışır — aşağıdaki query kullanır.
// ============================================================

const { query, withTransaction } = require("./db");
const clubsRepo = require("./repos/clubsRepo");

/** Haftalık bordro aralığı (ms). Prod: 7 gün; test: WAGE_INTERVAL_MS env. */
const WAGE_INTERVAL_MS = process.env.WAGE_INTERVAL_MS
  ? Number(process.env.WAGE_INTERVAL_MS)
  : 7 * 24 * 60 * 60 * 1000;

const MIN_WAGE = 500;
const MAX_WAGE = 120000;
const DEFAULT_CONTRACT_YEARS = 2;

function estimateWage(p) {
  if (!p) return MIN_WAGE;
  if (p.wage && Number(p.wage) > 0) return Math.floor(Number(p.wage));

  const skills = [
    "pace", "passing", "finishing", "tackle", "vision",
    "stamina", "strength", "technique", "agility", "positioning",
  ];
  const avg =
    skills.reduce((s, k) => s + (Number(p[k]) || 10), 0) / skills.length;
  const age = Number(p.age) || 24;
  const q = Number(p.baseQuality) || Math.round(avg / 2);
  const pot = Number(p.basePotential) || q;

  let w = 1200 + avg * 900 + q * 800 + pot * 350;
  if (age <= 21) w *= 0.85;
  else if (age <= 24) w *= 1.0;
  else if (age <= 28) w *= 1.15;
  else if (age <= 32) w *= 1.05;
  else w *= 0.7;

  // Kaleci / forvet hafif prim
  const pos = (p.pos || p.naturalPos || "").toUpperCase();
  if (pos === "GK") w *= 1.05;
  if (["FC", "FL", "FR"].includes(pos)) w *= 1.08;

  return Math.max(MIN_WAGE, Math.min(MAX_WAGE, Math.round(w / 100) * 100));
}

function estimateDemand(p) {
  // Yenilemede oyuncu talebi: mevcut maaşın %5–20 üstü
  const base = estimateWage(p);
  const age = Number(p.age) || 24;
  const happy = Number(p.happiness) || 80;
  let mult = 1.08;
  if (age <= 23) mult = 1.15;
  if (age >= 32) mult = 1.02;
  if (happy < 50) mult += 0.08;
  if (happy > 85) mult -= 0.03;
  return Math.max(MIN_WAGE, Math.min(MAX_WAGE, Math.round((base * mult) / 100) * 100));
}

function daysLeft(contractEndsAt) {
  if (!contractEndsAt) return null;
  const ms = new Date(contractEndsAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function publicPlayerContract(p) {
  const wage = estimateWage(p);
  const ends = p.contractEndsAt || p.contract_ends_at || null;
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    age: p.age,
    wage,
    wageWeekly: wage,
    wageMonthly: wage * 4,
    contractEndsAt: ends,
    daysLeft: daysLeft(ends),
    expiringSoon: ends ? daysLeft(ends) <= 90 : false,
    expired: ends ? daysLeft(ends) < 0 : false,
    happiness: Number(p.happiness) || 80,
    demand: estimateDemand(Object.assign({}, p, { wage })),
  };
}

/** Kulüp bordro özeti */
async function getPayroll(clubId) {
  const team = await clubsRepo.getTeam(clubId);
  if (!team) return null;

  const all = [...(team.players || []), ...(team.bench || [])];
  const rows = all.map(publicPlayerContract);
  const weeklyTotal = rows.reduce((s, r) => s + (r.wage || 0), 0);

  // Antrenör maaşları (varsa)
  let coachWeekly = 0;
  try {
    const { rows: coaches } = await query(
      `SELECT salary FROM club_coaches WHERE club_id = $1`,
      [clubId],
    );
    // coach salary tabloda "aylık" gibi tutulmuş; haftalığa ~ /4
    coachWeekly = coaches.reduce(
      (s, c) => s + Math.round(Number(c.salary || 0) / 4),
      0,
    );
  } catch (_) {}

  const club = await clubsRepo.getClub(clubId);
  return {
    players: rows.sort((a, b) => b.wage - a.wage),
    playerWeekly: weeklyTotal,
    coachWeekly,
    weeklyTotal: weeklyTotal + coachWeekly,
    monthlyTotal: (weeklyTotal + coachWeekly) * 4,
    balance: club ? Number(club.balance) : 0,
    lastPayrollAt: club && club.last_payroll_at ? club.last_payroll_at : null,
    wageIntervalMs: WAGE_INTERVAL_MS,
    expiring: rows.filter((r) => r.expiringSoon || r.expired),
  };
}

/**
 * Tek kulüp için bordro kesimi.
 * Yetersiz kasa → kısmi ödeme yok; mutluluk düşer, ödeme atlanır.
 */
async function payClubWages(clubId) {
  const club = await clubsRepo.getClub(clubId);
  if (!club) return { ok: false, error: "Kulüp yok" };

  // Çok sık ödeme engeli
  if (club.last_payroll_at) {
    const last = new Date(club.last_payroll_at).getTime();
    if (Date.now() - last < WAGE_INTERVAL_MS * 0.9) {
      return { ok: false, skipped: true, error: "Bordro henüz erken" };
    }
  }

  const payroll = await getPayroll(clubId);
  if (!payroll) return { ok: false, error: "Kadro yok" };

  const total = payroll.weeklyTotal;
  if (total <= 0) {
    await query(`UPDATE clubs SET last_payroll_at = NOW() WHERE id = $1`, [clubId]);
    return { ok: true, paid: 0, balance: payroll.balance };
  }

  if (Number(club.balance) < total) {
    // Ödenemedi → mutluluk -8 (min 20)
    await query(
      `UPDATE players SET happiness = GREATEST(20, COALESCE(happiness, 80) - 8)
       WHERE club_id = $1`,
      [clubId],
    );
    await query(`UPDATE clubs SET last_payroll_at = NOW() WHERE id = $1`, [clubId]);
    return {
      ok: false,
      unpaid: true,
      needed: total,
      balance: Number(club.balance),
      error: "Yetersiz kasa — maaşlar ödenemedi, moral düştü",
    };
  }

  const ok = await clubsRepo.adjustBalance(
    clubId,
    -total,
    "Haftalık maaş bordrosu (" +
      payroll.players.length +
      " oyuncu + antrenör)",
  );
  if (!ok) {
    return { ok: false, error: "Bütçe düşülemedi" };
  }

  await query(
    `UPDATE players SET last_wage_paid_at = NOW(),
       happiness = LEAST(100, COALESCE(happiness, 80) + 1)
     WHERE club_id = $1`,
    [clubId],
  );
  await query(`UPDATE clubs SET last_payroll_at = NOW() WHERE id = $1`, [clubId]);

  // Süresi dolmuş sözleşmeler: mutluluk cezası
  await query(
    `UPDATE players SET happiness = GREATEST(15, COALESCE(happiness, 80) - 12)
     WHERE club_id = $1 AND contract_ends_at IS NOT NULL AND contract_ends_at < NOW()`,
    [clubId],
  );

  return {
    ok: true,
    paid: total,
    playerWeekly: payroll.playerWeekly,
    coachWeekly: payroll.coachWeekly,
    balance: Number(club.balance) - total,
  };
}

/** Tüm insan kulüplerine bordro (botlar opsiyonel) */
async function runPayrollTick(opts = {}) {
  const includeBots = !!opts.includeBots;
  const { rows } = await query(
    includeBots
      ? `SELECT id FROM clubs`
      : `SELECT id FROM clubs WHERE COALESCE(is_bot, FALSE) = FALSE`,
  );
  const results = [];
  for (const r of rows) {
    try {
      const res = await payClubWages(r.id);
      results.push({ clubId: r.id, ...res });
    } catch (e) {
      results.push({ clubId: r.id, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Sözleşme yenile / teklif.
 * years: 1–5, wage: haftalık teklif.
 * Oyuncu talebinin altındaysa reddeder (mutluluk düşükse daha inatçı).
 */
async function renewContract(clubId, playerId, years, wage) {
  years = Math.max(1, Math.min(5, Math.floor(Number(years) || DEFAULT_CONTRACT_YEARS)));
  wage = Math.floor(Number(wage) || 0);

  const team = await clubsRepo.getTeam(clubId);
  if (!team) return { ok: false, error: "Takım yok" };
  const all = [...(team.players || []), ...(team.bench || [])];
  const player = all.find((p) => String(p.id) === String(playerId));
  if (!player) return { ok: false, error: "Oyuncu kadroda değil" };

  const demand = estimateDemand(player);
  if (wage < MIN_WAGE) return { ok: false, error: "Maaş çok düşük", demand };
  if (wage < Math.round(demand * 0.92)) {
    return {
      ok: false,
      error: "Oyuncu teklifi reddetti",
      demand,
      offered: wage,
    };
  }
  if (wage > MAX_WAGE) wage = MAX_WAGE;

  const ends = new Date();
  ends.setFullYear(ends.getFullYear() + years);

  await query(
    `UPDATE players SET
       wage = $3,
       contract_ends_at = $4,
       happiness = LEAST(100, COALESCE(happiness, 80) + 6)
     WHERE id = $1 AND club_id = $2`,
    [playerId, clubId, wage, ends.toISOString()],
  );

  return {
    ok: true,
    playerId,
    wage,
    years,
    contractEndsAt: ends.toISOString(),
    demand,
  };
}

/**
 * Yeni oyuncu (akademi / transfer) için varsayılan sözleşme yaz.
 * transferSystem / youthSystem çağırabilir.
 */
async function ensureContract(playerId, clubId, playerSnapshot) {
  const wage = estimateWage(playerSnapshot || {});
  const ends = new Date();
  ends.setFullYear(ends.getFullYear() + DEFAULT_CONTRACT_YEARS);
  await query(
    `UPDATE players SET
       wage = CASE WHEN COALESCE(wage, 0) <= 0 THEN $3 ELSE wage END,
       contract_ends_at = COALESCE(contract_ends_at, $4)
     WHERE id = $1 AND ($2::uuid IS NULL OR club_id = $2)`,
    [playerId, clubId || null, wage, ends.toISOString()],
  );
  return { wage, contractEndsAt: ends.toISOString() };
}

/** Serbest kalma: süresi dolmuş + kulüp yenilemezse club_id NULL (opsiyonel temizlik) */
async function releaseExpired(clubId) {
  const { rows } = await query(
    `UPDATE players SET club_id = NULL, is_starter = FALSE, bench_order = NULL
     WHERE club_id = $1
       AND contract_ends_at IS NOT NULL
       AND contract_ends_at < NOW() - INTERVAL '14 days'
       AND COALESCE(happiness, 80) < 40
     RETURNING id, name`,
    [clubId],
  );
  return { ok: true, released: rows };
}

/**
 * Tek oyuncuyu manuel serbest bırak (kulüp bordroyu azaltmak için).
 * İlk 11'deki oyuncu ve minimum kadro altına düşürecek serbest bırakma
 * reddedilir — client'taki "Serbest Bırak" ile aynı kurallar sunucuda
 * da zorlanır (önceden bu işlem yalnızca client hafızasında yapılıyor,
 * DB'deki oyuncu ve haftalık bordrosu hiç etkilenmiyordu).
 */
const MIN_SQUAD_SIZE = 11;
async function releasePlayer(clubId, playerId) {
  if (!clubId) return { ok: false, error: "Kulüp yok" };
  if (!playerId) return { ok: false, error: "playerId gerekli" };

  const { rows } = await query(
    `SELECT id, name, is_starter FROM players WHERE id = $1 AND club_id = $2`,
    [playerId, clubId],
  );
  const player = rows[0];
  if (!player) {
    return { ok: false, error: "Oyuncu kadronuzda değil" };
  }
  if (player.is_starter) {
    return { ok: false, error: "İlk 11'deki oyuncu serbest bırakılamaz. Önce yedeğe al." };
  }

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS c FROM players WHERE club_id = $1`,
    [clubId],
  );
  const total = countRows[0] ? countRows[0].c : 0;
  if (total <= MIN_SQUAD_SIZE) {
    return { ok: false, error: "Kadro çok küçük, oyuncu serbest bırakılamaz." };
  }

  await query(
    `UPDATE players SET club_id = NULL, is_starter = FALSE, bench_order = NULL
     WHERE id = $1 AND club_id = $2`,
    [playerId, clubId],
  );

  return { ok: true, released: { id: player.id, name: player.name } };
}

let _timer = null;
function startPayrollTimer(ms) {
  if (_timer) return;
  const interval = ms || Math.min(WAGE_INTERVAL_MS, 60 * 60 * 1000); // en fazla saatte bir kontrol
  _timer = setInterval(() => {
    runPayrollTick({ includeBots: false }).then((res) => {
      const paid = res.filter((r) => r.ok && r.paid);
      if (paid.length) {
        console.log("[contract] payroll", paid.length, "clubs");
      }
    }).catch((e) => console.error("[contract] payroll tick", e.message));
  }, interval);
}

module.exports = {
  estimateWage,
  estimateDemand,
  getPayroll,
  payClubWages,
  runPayrollTick,
  renewContract,
  ensureContract,
  releaseExpired,
  releasePlayer,
  startPayrollTimer,
  publicPlayerContract,
  WAGE_INTERVAL_MS,
  MIN_WAGE,
  MAX_WAGE,
};
