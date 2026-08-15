// ============================================================
// youthSystem.js — altyapı keşif + yükseltme
// ============================================================

const { query, withTransaction } = require("./db");
const clubsRepo = require("./repos/clubsRepo");
const economy = require("./economyBalance");

const POSITIONS = [
  "GK", "DL", "DC", "DC", "DR", "DM", "MC", "MC", "OMC", "FL", "FR", "FC", "ML", "MR",
];
const FIRST = [
  "Can", "Emre", "Burak", "Arda", "Kerem", "Yusuf", "Mert", "Ozan", "Hakan", "Cenk",
  "Yiğit", "Efe", "Alp", "Kaan", "Deniz", "Baran", "Emir", "Umut", "Ege", "Atlas",
];
const LAST = [
  "Yılmaz", "Demir", "Kaya", "Çelik", "Şahin", "Aydın", "Öztürk", "Arslan",
  "Doğan", "Kılıç", "Koç", "Polat", "Aslan", "Kurt", "Yıldız", "Özkan",
];

function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return date.getUTCFullYear() + "-W" + String(weekNo).padStart(2, "0");
}

async function ensureAcademy(clubId) {
  await query(
    `INSERT INTO youth_academy (club_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [clubId],
  );
}

async function getState(clubId) {
  await ensureAcademy(clubId);
  // Pending upgrade tamamlandı mı?
  await query(
    `UPDATE youth_academy SET
       scout_level = COALESCE(pending_scout_level, scout_level),
       pending_scout_level = NULL,
       scout_upgrade_until = NULL
     WHERE club_id = $1 AND pending_scout_level IS NOT NULL
       AND scout_upgrade_until IS NOT NULL AND scout_upgrade_until <= NOW()`,
    [clubId],
  );
  await query(
    `UPDATE youth_academy SET
       academy_level = COALESCE(pending_academy_level, academy_level),
       pending_academy_level = NULL,
       academy_upgrade_until = NULL
     WHERE club_id = $1 AND pending_academy_level IS NOT NULL
       AND academy_upgrade_until IS NOT NULL AND academy_upgrade_until <= NOW()`,
    [clubId],
  );

  const { rows } = await query(
    `SELECT scout_level, academy_level, draws_this_season, max_draws_per_season,
            last_draw_week_key, scout_upgrade_until, academy_upgrade_until,
            pending_scout_level, pending_academy_level
     FROM youth_academy WHERE club_id = $1`,
    [clubId],
  );
  const r = rows[0] || {};
  const { rows: recent } = await query(
    `SELECT name, pos, age, created_at FROM youth_discoveries
     WHERE club_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [clubId],
  );

  return {
    scoutLevel: Number(r.scout_level) || 1,
    academyLevel: Number(r.academy_level) || 1,
    maxScout: 5,
    maxAcademy: 5,
    drawsThisSeason: Number(r.draws_this_season) || 0,
    maxDrawsPerSeason: Number(r.max_draws_per_season) || 12,
    lastDrawWeekKey: r.last_draw_week_key || "",
    scoutUpgradeUntil: r.scout_upgrade_until
      ? new Date(r.scout_upgrade_until).getTime()
      : 0,
    academyUpgradeUntil: r.academy_upgrade_until
      ? new Date(r.academy_upgrade_until).getTime()
      : 0,
    pendingScoutLevel: r.pending_scout_level,
    pendingAcademyLevel: r.pending_academy_level,
    recent: (recent || []).map((x) => ({
      name: x.name,
      pos: x.pos,
      age: x.age,
      at: x.created_at ? new Date(x.created_at).getTime() : Date.now(),
    })),
  };
}

function rollPlayer(scoutLevel, academyLevel, preferredSkill) {
  const pos = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
  const age = 15 + Math.floor(Math.random() * 4); // 15-18
  const base =
    6 + scoutLevel * 0.9 + academyLevel * 0.7 + Math.random() * 3.5;
  const pot = Math.min(
    16,
    base + 1.5 + academyLevel * 0.5 + Math.random() * 2,
  );
  const name =
    FIRST[Math.floor(Math.random() * FIRST.length)] +
    " " +
    LAST[Math.floor(Math.random() * LAST.length)];

  const skills = {
    pace: base,
    passing: base,
    finishing: base,
    tackle: base,
    vision: base,
    stamina: base,
    strength: base,
    technique: base,
    agility: base,
    positioning: base,
    reflex: pos === "GK" ? base + 2 : 4 + Math.random() * 3,
    handling: pos === "GK" ? base + 2 : 3 + Math.random() * 2,
  };
  if (preferredSkill && skills[preferredSkill] != null) {
    skills[preferredSkill] += 1.2 + Math.random();
  }
  // Mevki bonusları
  if (pos === "GK") {
    skills.reflex += 2;
    skills.handling += 2;
    skills.finishing -= 2;
  }
  if (["FC", "FL", "FR"].includes(pos)) skills.finishing += 1.5;
  if (["MC", "OMC"].includes(pos)) skills.passing += 1.2;

  for (const k of Object.keys(skills)) {
    skills[k] = Math.max(4, Math.min(16, Math.round(skills[k] * 10) / 10));
  }

  return {
    name,
    pos,
    naturalPos: pos,
    age,
    number: 30 + Math.floor(Math.random() * 40),
    ...skills,
    condition: 90,
    form: 0,
    experience: age - 14,
    happiness: 70,
    baseQuality: Math.round(base / 2),
    basePotential: Math.round(pot / 2),
    fromAcademy: true,
    fromMarket: false,
    injured: false,
    injuryDaysLeft: 0,
    sentOff: false,
    cards: 0,
    goals: 0,
    assists: 0,
    wage: Math.round(400 + base * 80),
  };
}

async function drawPlayer(clubId, preferredSkill) {
  const state = await getState(clubId);
  if (state.drawsThisSeason >= state.maxDrawsPerSeason) {
    return { ok: false, error: "Sezon keşif limiti doldu" };
  }
  const wk = weekKey();
  // Haftada en fazla 2 keşif
  if (state.lastDrawWeekKey === wk && state.drawsThisSeason > 0) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c FROM youth_discoveries
       WHERE club_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [clubId],
    );
    if (rows[0] && rows[0].c >= 2) {
      return { ok: false, error: "Bu hafta en fazla 2 keşif yapılabilir" };
    }
  }

  const playerData = rollPlayer(
    state.scoutLevel,
    state.academyLevel,
    preferredSkill,
  );

  const player = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO players (
         club_id, name, number, pos, natural_pos, age,
         pace, passing, finishing, tackle, vision, stamina,
         strength, technique, agility, positioning, reflex, handling,
         condition, form, experience, happiness,
         base_quality, base_potential, from_academy, is_starter, wage
       ) VALUES (
         $1,$2,$3,$4,$5,$6,
         $7,$8,$9,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,
         $23,$24,TRUE,FALSE,$25
       ) RETURNING id`,
      [
        clubId,
        playerData.name,
        playerData.number,
        playerData.pos,
        playerData.naturalPos,
        playerData.age,
        playerData.pace,
        playerData.passing,
        playerData.finishing,
        playerData.tackle,
        playerData.vision,
        playerData.stamina,
        playerData.strength,
        playerData.technique,
        playerData.agility,
        playerData.positioning,
        playerData.reflex,
        playerData.handling,
        playerData.condition,
        playerData.form,
        playerData.experience,
        playerData.happiness,
        playerData.baseQuality,
        playerData.basePotential,
        playerData.wage,
      ],
    );
    const id = rows[0].id;
    await client.query(
      `INSERT INTO youth_discoveries (club_id, player_id, name, pos, age)
       VALUES ($1, $2, $3, $4, $5)`,
      [clubId, id, playerData.name, playerData.pos, playerData.age],
    );
    await client.query(
      `UPDATE youth_academy SET
         draws_this_season = draws_this_season + 1,
         last_draw_week_key = $2,
         updated_at = NOW()
       WHERE club_id = $1`,
      [clubId, wk],
    );
    return { ...playerData, id };
  });

  const newState = await getState(clubId);

  // Hook: daily challenges + achievements
  try {
    const { rows } = await query(
      `SELECT user_id FROM clubs WHERE id = $1`,
      [clubId],
    );
    const uid = rows[0] && rows[0].user_id;
    if (uid) {
      try {
        const daily = require("./dailyChallengeSystem");
        await daily.onYouthDraw(uid);
      } catch (_) {}
      try {
        const ach = require("./achievementsSystem");
        await ach.onYouthPromote(uid);
      } catch (_) {}
    }
  } catch (_) {}

  return { ok: true, player, state: newState };
}

async function upgrade(clubId, kind) {
  const state = await getState(clubId);
  const isScout = kind === "scout" || kind === "scoutLevel";
  const current = isScout ? state.scoutLevel : state.academyLevel;
  if (current >= 5) return { ok: false, error: "Maksimum seviye" };
  if (isScout && state.pendingScoutLevel) {
    return { ok: false, error: "Scout yükseltmesi devam ediyor" };
  }
  if (!isScout && state.pendingAcademyLevel) {
    return { ok: false, error: "Akademi yükseltmesi devam ediyor" };
  }

  const costFn = isScout
    ? economy.scoutUpgradeCostCalibrated
    : economy.academyUpgradeCostCalibrated;
  const cost =
    typeof costFn === "function"
      ? costFn(current)
      : 80000 * current * current;

  const paid = await clubsRepo.adjustBalance(
    clubId,
    -cost,
    isScout ? "Scout yükseltme" : "Akademi yükseltme",
  );
  if (!paid) return { ok: false, error: "Yetersiz bakiye", cost };

  const next = current + 1;
  const hours = 12 + current * 12; // 12–60 saat
  if (isScout) {
    await query(
      `UPDATE youth_academy SET
         pending_scout_level = $2,
         scout_upgrade_until = NOW() + ($3 || ' hours')::interval,
         updated_at = NOW()
       WHERE club_id = $1`,
      [clubId, next, String(hours)],
    );
  } else {
    await query(
      `UPDATE youth_academy SET
         pending_academy_level = $2,
         academy_upgrade_until = NOW() + ($3 || ' hours')::interval,
         updated_at = NOW()
       WHERE club_id = $1`,
      [clubId, next, String(hours)],
    );
  }

  const newState = await getState(clubId);
  return { ok: true, state: newState, cost, hours };
}

module.exports = {
  getState,
  drawPlayer,
  upgrade,
  ensureAcademy,
  weekKey,
};
