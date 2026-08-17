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
            pending_scout_level, pending_academy_level,
            COALESCE(home_draws_this_season, 0) AS home_draws_this_season
     FROM youth_academy WHERE club_id = $1`,
    [clubId],
  );
  const r = rows[0] || {};
  const { rows: recent } = await query(
    `SELECT name, pos, age, created_at FROM youth_discoveries
     WHERE club_id = $1 ORDER BY created_at DESC LIMIT 12`,
    [clubId],
  );

  let branches = [];
  try {
    const { rows: br } = await query(
      `SELECT country, built_at, build_cost FROM youth_branches
       WHERE club_id = $1 ORDER BY built_at ASC`,
      [clubId],
    );
    branches = (br || []).map((x) => ({
      country: x.country,
      builtAt: x.built_at ? new Date(x.built_at).getTime() : Date.now(),
      buildCost: Number(x.build_cost) || 0,
    }));
  } catch (_) {
    branches = [];
  }

  return {
    scoutLevel: Number(r.scout_level) || 1,
    academyLevel: Number(r.academy_level) || 1,
    maxScout: 5,
    maxAcademy: 5,
    drawsThisSeason: Number(r.draws_this_season) || 0,
    homeDrawsThisSeason: Number(r.home_draws_this_season) || 0,
    minHomeDraws: MIN_HOME_DRAWS,
    maxDrawsPerSeason: BASE_DRAWS_PER_SEASON + branches.length,
    lastDrawWeekKey: r.last_draw_week_key || "",
    scoutUpgradeUntil: r.scout_upgrade_until
      ? new Date(r.scout_upgrade_until).getTime()
      : 0,
    academyUpgradeUntil: r.academy_upgrade_until
      ? new Date(r.academy_upgrade_until).getTime()
      : 0,
    pendingScoutLevel: r.pending_scout_level,
    pendingAcademyLevel: r.pending_academy_level,
    branches,
    maxBranches: MAX_FOREIGN_BRANCHES,
    nextBranchCost: BRANCH_BUILD_COST,
    branchBuildCost: BRANCH_BUILD_COST,
    foreignDrawFee: 0,
    recent: (recent || []).map((x) => ({
      name: x.name,
      pos: x.pos,
      age: x.age,
      at: x.created_at ? new Date(x.created_at).getTime() : Date.now(),
    })),
  };
}

/**
 * Altyapı oyuncusu — gerçekçi yaş / kalite / potansiyel / mevki skill dağılımı.
 *
 * Skill ölçeği ~4–16 (oyun motoru ile uyumlu).
 * baseQuality / basePotential: 1–10 (UI yıldızları).
 *
 * Kurallar:
 * - 15–18 yaş: mevcut kalite düşük–orta; üst düzey kalite (8+) neredeyse yok.
 * - Üst düzey potansiyel (9–10) nadir; scout/academy seviyesi şansı artırır.
 * - Mevki ana skilleri yüksek, alakasız skiller düşük (ör. GK teknik düşük,
 *   reflex/handling yüksek).
 */
function clampSkill(v, lo, hi) {
  const a = lo != null ? lo : 4;
  const b = hi != null ? hi : 16;
  return Math.max(a, Math.min(b, Math.round(Number(v) * 10) / 10));
}

function rollBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** Nadir üst potansiyel: scout/academy yükseldikçe biraz daha sık */
function rollYouthQualityPotential(age, scoutLevel, academyLevel) {
  const s = Math.max(0, Number(scoutLevel) || 1);
  const a = Math.max(0, Number(academyLevel) || 1);
  const agePenalty = Math.max(0, 18 - age) * 0.15; // daha genç → biraz daha ham

  // Mevcut kalite (1–10): gençler genelde 2–5, nadiren 6–7
  let qRoll = Math.random();
  let quality;
  if (qRoll < 0.55) quality = rollBetween(2.0, 3.8); // sıradan
  else if (qRoll < 0.85) quality = rollBetween(3.8, 5.2); // iyi genç
  else if (qRoll < 0.97) quality = rollBetween(5.2, 6.4); // dikkat çeken
  else quality = rollBetween(6.4, 7.2); // çok nadir "hazır" genç (üst düzey değil)

  // Scout/academy hafif boost (kaliteyi 8+ yapmaz)
  quality += Math.min(0.9, s * 0.08 + a * 0.06) - agePenalty;
  quality = Math.max(1.5, Math.min(7.2, quality));

  // Potansiyel ≥ kalite; üst düzey (9–10) nadir
  const gapBase = rollBetween(0.8, 2.8);
  let potential = quality + gapBase + s * 0.12 + a * 0.15;
  const eliteChance = 0.02 + s * 0.008 + a * 0.01; // ~%2–%8
  if (Math.random() < eliteChance) {
    potential = rollBetween(9.0, 10.0);
  } else if (Math.random() < 0.12 + s * 0.02) {
    potential = Math.max(potential, rollBetween(7.5, 8.8));
  }
  potential = Math.max(quality + 0.5, Math.min(10, potential));

  return {
    baseQuality: Math.round(quality * 10) / 10,
    basePotential: Math.round(potential * 10) / 10,
  };
}

/** Mevkiye göre skill şablonu: primary yüksek, secondary orta, weak düşük */
function positionSkillProfile(pos) {
  const p = String(pos || "MC").toUpperCase();
  // Her skill: "primary" | "secondary" | "weak" | "gk_only"
  if (p === "GK") {
    return {
      pace: "weak",
      passing: "weak",
      finishing: "weak",
      tackle: "weak",
      vision: "secondary",
      stamina: "secondary",
      strength: "secondary",
      technique: "weak", // kalecide teknik yüksek olmaz
      agility: "primary",
      positioning: "primary",
      reflex: "primary",
      handling: "primary",
    };
  }
  if (["DC", "DL", "DR"].includes(p)) {
    return {
      pace: p === "DC" ? "secondary" : "primary",
      passing: "secondary",
      finishing: "weak",
      tackle: "primary",
      vision: "secondary",
      stamina: "primary",
      strength: p === "DC" ? "primary" : "secondary",
      technique: "secondary",
      agility: p === "DC" ? "weak" : "secondary",
      positioning: "primary",
      reflex: "weak",
      handling: "weak",
    };
  }
  if (p === "DM") {
    return {
      pace: "secondary",
      passing: "primary",
      finishing: "weak",
      tackle: "primary",
      vision: "primary",
      stamina: "primary",
      strength: "primary",
      technique: "secondary",
      agility: "secondary",
      positioning: "primary",
      reflex: "weak",
      handling: "weak",
    };
  }
  if (["MC", "ML", "MR"].includes(p)) {
    return {
      pace: ["ML", "MR"].includes(p) ? "primary" : "secondary",
      passing: "primary",
      finishing: "secondary",
      tackle: "secondary",
      vision: "primary",
      stamina: "primary",
      strength: "secondary",
      technique: "primary",
      agility: ["ML", "MR"].includes(p) ? "primary" : "secondary",
      positioning: "secondary",
      reflex: "weak",
      handling: "weak",
    };
  }
  if (p === "OMC") {
    return {
      pace: "secondary",
      passing: "primary",
      finishing: "primary",
      tackle: "weak",
      vision: "primary",
      stamina: "secondary",
      strength: "weak",
      technique: "primary",
      agility: "primary",
      positioning: "secondary",
      reflex: "weak",
      handling: "weak",
    };
  }
  // FL / FR / FC
  return {
    pace: p === "FC" ? "secondary" : "primary",
    passing: "secondary",
    finishing: "primary",
    tackle: "weak",
    vision: "secondary",
    stamina: "secondary",
    strength: p === "FC" ? "primary" : "secondary",
    technique: "primary",
    agility: p === "FC" ? "secondary" : "primary",
    positioning: "primary",
    reflex: "weak",
    handling: "weak",
  };
}

function skillFromTier(tier, quality, potential, age) {
  // quality 1–10 → skill merkezi ~5–11; gençler biraz daha düşük tavan
  const q = Math.max(1, Math.min(10, quality));
  const pot = Math.max(q, Math.min(10, potential));
  const ageFactor = 0.88 + (age - 15) * 0.04; // 15→0.88, 18→1.00
  const center = (4.5 + q * 0.75) * ageFactor;
  // Potansiyelin bir kısmı skill'e sızmasın diye hafif (ham yetenek)
  const potHint = (pot - q) * 0.15;

  let lo;
  let hi;
  if (tier === "primary") {
    lo = center + potHint + 0.8;
    hi = center + potHint + 2.8;
  } else if (tier === "secondary") {
    lo = center - 0.6;
    hi = center + 1.2;
  } else {
    // weak / non-position
    lo = 4.0 + q * 0.15;
    hi = 5.5 + q * 0.35;
  }
  // Mutlak tavan: 16 yaşında 14+ skill olmasın
  const hardCap = age <= 16 ? 12.5 : age <= 17 ? 13.5 : 14.5;
  return clampSkill(rollBetween(lo, hi), 4, hardCap);
}

const MAX_FOREIGN_BRANCHES = 6;
const BASE_DRAWS_PER_SEASON = 12;
const MIN_HOME_DRAWS = 6;
/** Tüm ülkelerde aynı şube inşa ücreti */
const BRANCH_BUILD_COST = 400000;

function branchBuildCost(_existingCount) {
  return BRANCH_BUILD_COST;
}

function foreignDrawFee() {
  return 0;
}

const NAME_POOLS = {
  Türkiye: { f: ["Arda","Kerem","Yusuf","Mert","Ozan","Hakan","Cenk","Yiğit","Efe","Alp","Kaan","Deniz","Baran","Emir","Umut"], l: ["Yılmaz","Demir","Kaya","Çelik","Şahin","Aydın","Öztürk","Arslan","Doğan","Kılıç"] },
  Almanya: { f: ["Leon","Lukas","Finn","Paul","Jonas","Noah","Tim","Max","Ben","Felix"], l: ["Müller","Schmidt","Schneider","Fischer","Weber","Wagner","Becker","Hoffmann"] },
  İngiltere: { f: ["Harry","Jack","Oliver","George","Noah","Leo","Arthur","Oscar","Henry","Charlie"], l: ["Smith","Jones","Williams","Brown","Taylor","Wilson","Davies","Evans"] },
  İspanya: { f: ["Pablo","Hugo","Martín","Daniel","Alejandro","Álvaro","Adrián","Diego","Lucas","Mario"], l: ["García","Rodríguez","González","Fernández","López","Martínez","Sánchez","Pérez"] },
  İtalya: { f: ["Marco","Luca","Alessandro","Andrea","Matteo","Francesco","Lorenzo","Giovanni","Davide","Simone"], l: ["Rossi","Russo","Ferrari","Esposito","Bianchi","Romano","Colombo","Ricci"] },
  Fransa: { f: ["Hugo","Louis","Gabriel","Arthur","Lucas","Jules","Léo","Adam","Raphaël","Noah"], l: ["Martin","Bernard","Dubois","Thomas","Robert","Richard","Petit","Durand"] },
  Brezilya: { f: ["Gabriel","Lucas","Matheus","Rafael","Bruno","Thiago","Felipe","Vinícius","Caio","Igor"], l: ["Silva","Santos","Oliveira","Souza","Rodrigues","Ferreira","Almeida","Costa"] },
  Arjantin: { f: ["Mateo","Santiago","Nicolás","Franco","Agustín","Lucas","Joaquín","Tomás","Facundo","Gonzalo"], l: ["González","Rodríguez","Fernández","López","Martínez","García","Pérez","Sánchez"] },
  Portekiz: { f: ["João","Diogo","Miguel","Tiago","Rui","Pedro","André","Bruno","Ricardo","Nuno"], l: ["Silva","Santos","Ferreira","Pereira","Oliveira","Costa","Rodrigues","Martins"] },
  Hollanda: { f: ["Daan","Sem","Lucas","Bram","Thijs","Milan","Luuk","Finn","Max","Tim"], l: ["de Jong","Bakker","Visser","Smit","Meijer","Jansen","de Vries","van Dijk"] },
  Japonya: { f: ["Haruto","Yuto","Sota","Ren","Hiroto","Kaito","Riku","Yuma","Sosuke","Takumi"], l: ["Sato","Suzuki","Takahashi","Tanaka","Watanabe","Ito","Yamamoto","Nakamura"] },
  "Güney Kore": { f: ["Min-jun","Seo-jun","Do-yun","Ye-jun","Si-woo","Ji-ho","Jun-seo","Ha-jun","Joon","Min"], l: ["Kim","Lee","Park","Choi","Jung","Kang","Cho","Yoon"] },
  Mısır: { f: ["Mohamed","Ahmed","Omar","Youssef","Karim","Hassan","Mahmoud","Ali","Ibrahim","Tarek"], l: ["Hassan","Ali","Ibrahim","Mahmoud","Said","Mostafa","Saleh","Nasser"] },
  Nijerya: { f: ["Chukwudi","Emeka","Tunde","Segun","Ibrahim","Musa","Adebayo","Chinedu","Oluwaseun","Kayode"], l: ["Okafor","Adebayo","Okonkwo","Balogun","Nwosu","Ibrahim","Musa","Ogunleye"] },
  ABD: { f: ["Jake","Tyler","Brandon","Cody","Ethan","Noah","Liam","Mason","Logan","Hunter"], l: ["Smith","Johnson","Williams","Brown","Jones","Miller","Davis","Wilson"] },
  Rusya: { f: ["Ivan","Dmitri","Alexei","Sergei","Andrei","Nikolai","Pavel","Roman","Igor","Maxim"], l: ["Ivanov","Smirnov","Kuznetsov","Popov","Sokolov","Lebedev","Kozlov","Novikov"] },
};

function nameForCountry(country) {
  const pool = NAME_POOLS[country] || NAME_POOLS["Türkiye"];
  const f = pool.f[Math.floor(Math.random() * pool.f.length)];
  const l = pool.l[Math.floor(Math.random() * pool.l.length)];
  return f + " " + l;
}

async function getClubCountry(clubId) {
  try {
    const { rows } = await query(`SELECT country FROM clubs WHERE id = $1`, [clubId]);
    return (rows[0] && rows[0].country) || "Türkiye";
  } catch (_) {
    return "Türkiye";
  }
}

async function listBranches(clubId) {
  try {
    const { rows } = await query(
      `SELECT country, built_at, build_cost FROM youth_branches WHERE club_id = $1 ORDER BY built_at`,
      [clubId],
    );
    return (rows || []).map((x) => ({
      country: x.country,
      builtAt: x.built_at ? new Date(x.built_at).getTime() : Date.now(),
      buildCost: Number(x.build_cost) || 0,
    }));
  } catch (_) {
    return [];
  }
}

/**
 * Ücret karşılığı yabancı altyapı şubesi inşa et.
 */
async function buildBranch(clubId, country) {
  const { normalizeCountry, isSupportedCountry } = require("./countries");
  if (!country || !isSupportedCountry(country)) {
    return { ok: false, error: "Geçersiz ülke" };
  }
  const c = normalizeCountry(country);
  const home = await getClubCountry(clubId);
  if (c === home) {
    return { ok: false, error: "Kendi ülkende zaten akademin var" };
  }
  const branches = await listBranches(clubId);
  if (branches.some((b) => b.country === c)) {
    return { ok: false, error: "Bu ülkede zaten şuben var" };
  }
  if (branches.length >= MAX_FOREIGN_BRANCHES) {
    return { ok: false, error: "En fazla " + MAX_FOREIGN_BRANCHES + " yabancı şube kurabilirsin" };
  }
  const cost = branchBuildCost(branches.length);
  const paid = await clubsRepo.adjustBalance(
    clubId,
    -cost,
    "Altyapı şubesi: " + c,
  );
  if (!paid) return { ok: false, error: "Yetersiz bakiye", cost };

  try {
    await query(
      `INSERT INTO youth_branches (club_id, country, build_cost) VALUES ($1, $2, $3)
       ON CONFLICT (club_id, country) DO NOTHING`,
      [clubId, c, cost],
    );
  } catch (e) {
    // Tablo yoksa kullanıcıya net mesaj
    if (String(e.message || "").includes("youth_branches")) {
      await clubsRepo.adjustBalance(clubId, cost, "İade: şube tablosu yok");
      return { ok: false, error: "Şube sistemi henüz aktif değil (migration 036)" };
    }
    throw e;
  }
  const state = await getState(clubId);
  return { ok: true, country: c, cost, state };
}

function rollPlayer(scoutLevel, academyLevel, preferredSkill, country) {
  const pos = POSITIONS[Math.floor(Math.random() * POSITIONS.length)];
  const age = 15 + Math.floor(Math.random() * 4); // 15-18
  const { baseQuality, basePotential } = rollYouthQualityPotential(
    age,
    scoutLevel,
    academyLevel,
  );
  const name = nameForCountry(country || "Türkiye");

  const profile = positionSkillProfile(pos);
  const skills = {};
  for (const key of Object.keys(profile)) {
    skills[key] = skillFromTier(profile[key], baseQuality, basePotential, age);
  }

  // Tercih edilen skill: yalnızca mevki ile uyumluysa güçlendir
  if (preferredSkill && skills[preferredSkill] != null) {
    const tier = profile[preferredSkill];
    if (tier === "primary" || tier === "secondary") {
      skills[preferredSkill] = clampSkill(
        skills[preferredSkill] + 0.6 + Math.random() * 0.8,
        4,
        age <= 16 ? 12.5 : 14,
      );
    }
  }

  // GK: teknik / bitiricilik / tempo asla şişmesin
  if (pos === "GK") {
    skills.technique = clampSkill(
      Math.min(skills.technique, 5.5 + baseQuality * 0.25),
      4,
      8,
    );
    skills.finishing = clampSkill(
      Math.min(skills.finishing, 4.2 + Math.random()),
      4,
      6.5,
    );
    skills.pace = clampSkill(Math.min(skills.pace, 6 + baseQuality * 0.3), 4, 9);
    skills.reflex = clampSkill(
      Math.max(skills.reflex, skills.reflex + 0.3),
      4,
      age <= 16 ? 12.5 : 14,
    );
    skills.handling = clampSkill(
      Math.max(skills.handling, skills.handling + 0.3),
      4,
      age <= 16 ? 12.5 : 14,
    );
  }

  // Saha oyuncusunda kaleci skill'leri düşük kalsın
  if (pos !== "GK") {
    skills.reflex = clampSkill(4 + Math.random() * 2.2, 4, 7);
    skills.handling = clampSkill(3.5 + Math.random() * 2, 4, 6.5);
  }

  for (const k of Object.keys(skills)) {
    skills[k] = clampSkill(skills[k], 4, 16);
  }

  const avgPrimary =
    Object.keys(profile)
      .filter((k) => profile[k] === "primary")
      .reduce((s, k) => s + skills[k], 0) /
    Math.max(
      1,
      Object.keys(profile).filter((k) => profile[k] === "primary").length,
    );

  return {
    name,
    pos,
    naturalPos: pos,
    age,
    number: 30 + Math.floor(Math.random() * 40),
    ...skills,
    condition: 88 + Math.floor(Math.random() * 12),
    form: 0,
    experience: Math.max(0.5, age - 14.5 + Math.random()),
    happiness: 65 + Math.floor(Math.random() * 25),
    baseQuality: Math.max(1, Math.min(10, Math.round(baseQuality))),
    basePotential: Math.max(1, Math.min(10, Math.round(basePotential))),
    fromAcademy: true,
    fromMarket: false,
    injured: false,
    injuryDaysLeft: 0,
    sentOff: false,
    cards: 0,
    goals: 0,
    assists: 0,
    wage: Math.round(350 + baseQuality * 90 + (basePotential - baseQuality) * 40),
  };
}

async function drawPlayer(clubId, preferredSkill, country) {
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

  const home = await getClubCountry(clubId);
  const { normalizeCountry, isSupportedCountry } = require("./countries");
  let drawCountry = home;
  const homeDraws = Number(state.homeDrawsThisSeason) || 0;
  if (country && String(country).trim()) {
    const c = normalizeCountry(String(country).trim());
    if (!isSupportedCountry(c)) {
      return { ok: false, error: "Geçersiz ülke" };
    }
    if (c !== home) {
      if (homeDraws < MIN_HOME_DRAWS) {
        return {
          ok: false,
          error:
            "Önce kendi ülkenizden " +
            MIN_HOME_DRAWS +
            " oyuncu çekmelisiniz (" +
            homeDraws +
            "/" +
            MIN_HOME_DRAWS +
            ")",
        };
      }
      const has = (state.branches || []).some((b) => b.country === c);
      if (!has) {
        return { ok: false, error: "Bu ülkede altyapı şuben yok — önce inşa et" };
      }
      drawCountry = c;
    }
  }

  const playerData = rollPlayer(
    state.scoutLevel,
    state.academyLevel,
    preferredSkill,
    drawCountry,
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
    const isHome = drawCountry === home;
    await client.query(
      `UPDATE youth_academy SET
         draws_this_season = draws_this_season + 1,
         home_draws_this_season = COALESCE(home_draws_this_season, 0) + CASE WHEN $3 THEN 1 ELSE 0 END,
         last_draw_week_key = $2,
         updated_at = NOW()
       WHERE club_id = $1`,
      [clubId, wk, isHome],
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
  buildBranch,
  listBranches,
  branchBuildCost,
  foreignDrawFee,
  MAX_FOREIGN_BRANCHES,
  BASE_DRAWS_PER_SEASON,
  MIN_HOME_DRAWS,
  BRANCH_BUILD_COST,
};
