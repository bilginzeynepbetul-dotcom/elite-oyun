// ============================================================
// youthSystem.js — SUNUCU TARAFLI ALTYAPI / AKADEMİ (async DB)
// ------------------------------------------------------------
// configure({ getClub, adjustBalance, getTeam, saveTeam,
//             getYouthState, saveYouthState })
//
// Client tarafındaki generateYouthPlayer() / upgradeDurationMs()
// / scoutUpgradeCost() / academyUpgradeCost() mantığıyla birebir
// uyumlu olacak şekilde yazıldı (bkz. public/index.html).
// ============================================================

const youthRepo = require("./repos/youthRepo");

const MAX_SCOUT_LEVEL = 5;
const MAX_ACADEMY_LEVEL = 5;
const DEFAULT_MAX_DRAWS_PER_SEASON = 12;

/** 1→2: 5dk · 2→3: 15dk · 3→4: 45dk · 4→5: 120dk · 5: 180dk */
const UPGRADE_MINUTES_BY_LEVEL = { 1: 5, 2: 15, 3: 45, 4: 120, 5: 180 };

const POSITIONS = [
  "GK", "DL", "DR", "DC", "DM", "MC", "ML", "MR", "OMC", "FL", "FC", "FR",
];
const POSITIONS_BY_FAMILY = {
  GK: ["GK"],
  DF: ["DL", "DR", "DC"],
  MF: ["DM", "MC", "ML", "MR", "OMC"],
  FW: ["FL", "FC", "FR"],
};

const FIRST_NAMES = [
  "Ali", "Mehmet", "Ahmet", "Mustafa", "Hasan", "Hüseyin", "İbrahim",
  "Yusuf", "Ömer", "Murat", "Serkan", "Tolga", "Cem", "Barış", "Onur",
  "Emre", "Can", "Burak", "Kerem", "Arda", "Berkay", "Volkan", "Kaan",
  "Mert", "Furkan", "Deniz", "Alp", "Yiğit", "Efe", "Umut", "Gökhan",
  "Selim", "Taner", "Baran", "Enes", "Uğur", "Erhan", "Sinan",
  "Metehan", "Kağan", "Bora", "Eren", "Kenan", "Bahadır", "Tayfun",
  "Oğuzhan", "Görkem", "İlker", "Rıdvan", "Semih", "Doruk", "Berkan",
  "Cenk", "Ozan", "Hakan", "Çağatay", "Tuna", "Batuhan", "Koray",
  "Levent", "Alper", "Faruk", "Salih", "Vedat", "Zafer", "Metin",
  "Atakan", "Emir", "Ferhat", "Harun", "İdris", "Kuzey", "Okan",
  "Samet", "Utku", "Yavuz", "Zeki", "Berke", "Ege", "Fırat", "Sarp",
  "Taha", "Poyraz", "Rüzgar", "Çınar", "Alparslan", "Abdullah", "Adem",
  "Anıl", "Berk", "Bilal", "Cengiz", "Doğan", "Erdem", "Erkan", "Fatih",
  "Hamza", "İlyas", "Kadir", "Kemal", "Mahmut", "Mesut", "Oğuz", "Özgür",
  "Rıza", "Sami", "Selçuk", "Tarık", "Turgut", "Ümit", "Yakup", "Yalçın",
];
const LAST_NAMES = [
  "Yılmaz", "Kaya", "Demir", "Şahin", "Çelik", "Aydın", "Öztürk",
  "Arslan", "Doğan", "Kılıç", "Aslan", "Koç", "Polat", "Kurt", "Yıldız",
  "Özdemir", "Çetin", "Aksoy", "Bulut", "Sarı", "Yavuz", "Erdoğan",
  "Güneş", "Korkmaz", "Kaplan", "Türk", "Avcı", "Yıldırım", "Aktaş",
  "Öz", "Karaca", "Tunç", "Uçar", "Bozkurt", "Aygün", "Çakır", "Duman",
  "Ergin", "Kandemir", "Özkan", "Tekin", "Yalçın", "Şimşek", "Gündoğdu",
  "Acar", "Akın", "Ateş", "Bayram", "Can", "Çakmak", "Dal", "Durmuş",
  "Efe", "Ekici", "Erdem", "Gezer", "Gök", "Güler", "Işık", "Kara",
  "Karaman", "Kartal", "Keskin", "Köse", "Kutlu", "Mutlu", "Özer",
  "Sağlam", "Sezer", "Soylu", "Taş", "Toprak", "Tuna", "Türkmen",
  "Uysal", "Ünal", "Varol", "Yağcı", "Yaman", "Yiğit", "Zengin",
  "Akbulut", "Akgün", "Altın", "Arı", "Atalay", "Bakır", "Başaran",
  "Bayraktar", "Ceylan", "Çağlar", "Dağ", "Ekinci", "Gökçe", "Gürbüz",
  "Karadağ", "Kayaalp", "Özbay", "Pektaş", "Solak", "Tan", "Ulu",
];

/** clubId → state */
const store = new Map();

let deps = {
  getClub: null,
  adjustBalance: null,
  getTeam: null,
  saveTeam: null,
  getYouthState: null,
  saveYouthState: null,
  log: console.log,
};

function configure(next) {
  deps = Object.assign(deps, next || {});
}

async function _call(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  return await Promise.resolve(fn(...args));
}

function defaultState() {
  return {
    scoutLevel: 1,
    academyLevel: 1,
    drawsThisSeason: 0,
    maxDrawsPerSeason: DEFAULT_MAX_DRAWS_PER_SEASON,
    lastDrawWeekKey: "",
    scoutUpgradeUntil: 0,
    academyUpgradeUntil: 0,
    pendingScoutLevel: null,
    pendingAcademyLevel: null,
    recent: [],
  };
}

function upgradeDurationMs(currentLevel) {
  const lv = Math.max(1, Math.min(5, Math.floor(Number(currentLevel) || 1)));
  return (UPGRADE_MINUTES_BY_LEVEL[lv] || 180) * 60 * 1000;
}

function scoutUpgradeCost(level) {
  return 150000 * (level || 1);
}

function academyUpgradeCost(level) {
  return 200000 * (level || 1);
}

/** ISO hafta anahtarı (client'taki weekKeyNow() ile aynı) */
function weekKeyNow() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + weekNo;
}

async function loadState(clubId) {
  if (store.has(clubId)) return store.get(clubId);
  let s = null;
  if (typeof deps.getYouthState === "function") {
    try {
      s = await _call(deps.getYouthState, clubId);
    } catch (e) {}
  }
  if (!s) s = defaultState();
  if (!Array.isArray(s.recent)) s.recent = [];
  store.set(clubId, s);
  return s;
}

async function persist(clubId, s) {
  store.set(clubId, s);
  if (typeof deps.saveYouthState === "function") {
    try {
      await _call(deps.saveYouthState, clubId, s);
    } catch (e) {}
  }
}

function publicState(s) {
  const maxDraws = s.maxDrawsPerSeason || DEFAULT_MAX_DRAWS_PER_SEASON;
  return {
    scoutLevel: s.scoutLevel || 1,
    academyLevel: s.academyLevel || 1,
    maxScout: MAX_SCOUT_LEVEL,
    maxAcademy: MAX_ACADEMY_LEVEL,
    drawsThisSeason: s.drawsThisSeason || 0,
    maxDrawsPerSeason: maxDraws,
    lastDrawWeekKey: s.lastDrawWeekKey || "",
    scoutUpgradeUntil: s.scoutUpgradeUntil || 0,
    academyUpgradeUntil: s.academyUpgradeUntil || 0,
    pendingScoutLevel: s.pendingScoutLevel || null,
    pendingAcademyLevel: s.pendingAcademyLevel || null,
    canDrawThisWeek: (s.drawsThisSeason || 0) < maxDraws,
    scoutCost: scoutUpgradeCost(s.scoutLevel || 1),
    academyCost: academyUpgradeCost(s.academyLevel || 1),
    recent: (s.recent || []).slice(0, 20),
  };
}

async function getState(clubId) {
  const s = await loadState(clubId);
  return publicState(s);
}

function randomYouthName() {
  const f = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const l = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return f + " " + l;
}

function stat(base) {
  return Math.round(Math.max(1, Math.min(18, base + (Math.random() * 4 - 2))));
}

function familyOf(pos) {
  if (pos === "GK") return "GK";
  if (pos === "DL" || pos === "DR" || pos === "DC") return "DF";
  if (pos === "DM" || pos === "MC" || pos === "ML" || pos === "MR") return "MF";
  if (pos === "OMC") return "AM";
  return "FW";
}

/** generateYouthPlayer() (public/index.html) ile birebir aynı mantık */

function rollYouthPotential(academyLevel, scoutLevel) {
  const acad = Math.max(1, Math.min(5, Number(academyLevel) || 1));
  const scout = Math.max(1, Number(scoutLevel) || 1);
  let hardMax = 7;
  if (acad >= 5) hardMax = 10;
  else if (acad >= 4) hardMax = 9;
  else if (acad >= 3) hardMax = 8;
  const r = Math.random();
  let pot;
  if (r < 0.06) pot = 3;
  else if (r < 0.22) pot = 4;
  else if (r < 0.48) pot = 5;
  else if (r < 0.72) pot = 6;
  else if (r < 0.88) pot = 7;
  else if (r < 0.96) pot = 8;
  else if (r < 0.993) pot = 9;
  else pot = 10;
  if (scout >= 3 && Math.random() < 0.08) pot = Math.min(10, pot + 1);
  if (scout >= 5 && Math.random() < 0.05) pot = Math.min(10, pot + 1);
  pot = Math.min(pot, hardMax);
  if (pot === 9 && Math.random() > 0.12) pot = 8;
  if (pot === 10) {
    if (acad < 5) pot = 8;
    else if (Math.random() > 0.35) pot = 9;
  }
  return Math.max(1, Math.min(10, pot));
}

function generatePlayer(scoutLevel, academyLevel, preferredFamily, preferredSkill) {
  let positions = POSITIONS;
  if (preferredFamily && POSITIONS_BY_FAMILY[preferredFamily]) {
    positions = POSITIONS_BY_FAMILY[preferredFamily];
  }
  if (preferredSkill && !preferredFamily) {
    if (preferredSkill === "reflex" || preferredSkill === "handling") positions = ["GK"];
    else if (preferredSkill === "finishing") positions = ["FC", "FL", "FR", "OMC"];
    else if (preferredSkill === "tackle") positions = ["DC", "DL", "DR", "DM"];
    else if (preferredSkill === "passing" || preferredSkill === "vision")
      positions = ["MC", "DM", "OMC", "ML", "MR"];
  }
  const pos = positions[Math.floor(Math.random() * positions.length)];
  const scoutLv = Math.max(1, Number(scoutLevel) || 1);
  const acadLv = Math.max(1, Math.min(5, Number(academyLevel) || 1));
  const scoutBonus = (scoutLv - 1) * 0.6;
  let quality = Math.round(1 + Math.random() * 3.5 + scoutBonus * 0.4);
  quality = Math.max(1, Math.min(5, quality));
  // Pot 10 yalnız akademi 5; 9–10 nadir
  let potential = rollYouthPotential(acadLv, scoutLv);
  potential = Math.max(quality, potential);
  const age = 16; // altyapı yalnızca 16 yaş
  const cur = 3 + quality * 1.05 + Math.random() * 1.6; // genel seviye düşük-orta
  const fam = familyOf(pos);
  const p = String(pos || "").toUpperCase();
  const isGk = p === "GK";
  function sk(mod, primary) {
    const spread = primary ? 1.5 : 2.2;
    const v = cur + mod + (Math.random() - 0.5) * spread;
    return Math.max(4, Math.min(16, Math.round(v * 10) / 10));
  }
  // Mevki modları (botClubs ile uyumlu, gençler biraz daha düşük tavan)
  const mods = {
    GK:  { pace: -2.0, passing: -0.6, finishing: -3.5, tackle: -1.8, vision: -0.5, stamina: -0.4, strength: 0.3, technique: -0.4, agility: 1.2, positioning: 2.0, reflex: 3.8, handling: 3.6 },
    DC:  { pace: -0.6, passing: -0.5, finishing: -2.4, tackle: 2.8, vision: -0.6, stamina: 0.9, strength: 2.0, technique: -0.5, agility: -0.5, positioning: 2.6, reflex: -2.5, handling: -3.5 },
    DL:  { pace: 1.2, passing: 0.2, finishing: -1.8, tackle: 1.8, vision: -0.3, stamina: 1.0, strength: 0.4, technique: 0.2, agility: 0.9, positioning: 1.4, reflex: -2.5, handling: -3.5 },
    DR:  { pace: 1.2, passing: 0.2, finishing: -1.8, tackle: 1.8, vision: -0.3, stamina: 1.0, strength: 0.4, technique: 0.2, agility: 0.9, positioning: 1.4, reflex: -2.5, handling: -3.5 },
    DM:  { pace: -0.3, passing: 1.2, finishing: -1.6, tackle: 2.0, vision: 0.7, stamina: 1.3, strength: 1.0, technique: 0.3, agility: -0.2, positioning: 1.3, reflex: -2.5, handling: -3.5 },
    MC:  { pace: 0.2, passing: 2.0, finishing: -0.6, tackle: 0.5, vision: 1.9, stamina: 1.2, strength: 0.1, technique: 1.3, agility: 0.3, positioning: 0.6, reflex: -2.5, handling: -3.5 },
    ML:  { pace: 1.5, passing: 1.0, finishing: 0.2, tackle: -0.5, vision: 0.6, stamina: 1.0, strength: -0.3, technique: 1.2, agility: 1.4, positioning: 0.2, reflex: -2.5, handling: -3.5 },
    MR:  { pace: 1.5, passing: 1.0, finishing: 0.2, tackle: -0.5, vision: 0.6, stamina: 1.0, strength: -0.3, technique: 1.2, agility: 1.4, positioning: 0.2, reflex: -2.5, handling: -3.5 },
    OMC: { pace: 0.3, passing: 2.2, finishing: 1.0, tackle: -1.0, vision: 2.4, stamina: 0.5, strength: -0.3, technique: 1.8, agility: 0.7, positioning: 0.5, reflex: -2.5, handling: -3.5 },
    FL:  { pace: 2.0, passing: 0.5, finishing: 1.3, tackle: -1.3, vision: 0.3, stamina: 0.7, strength: -0.5, technique: 1.3, agility: 1.9, positioning: 0.2, reflex: -2.5, handling: -3.5 },
    FR:  { pace: 2.0, passing: 0.5, finishing: 1.3, tackle: -1.3, vision: 0.3, stamina: 0.7, strength: -0.5, technique: 1.3, agility: 1.9, positioning: 0.2, reflex: -2.5, handling: -3.5 },
    FC:  { pace: 0.7, passing: -0.3, finishing: 2.9, tackle: -1.6, vision: 0.2, stamina: 0.7, strength: 1.5, technique: 1.2, agility: 0.5, positioning: 1.3, reflex: -2.5, handling: -3.5 },
  }[p] || { pace: 0, passing: 0.5, finishing: 0, tackle: 0, vision: 0.5, stamina: 0.5, strength: 0, technique: 0.5, agility: 0.3, positioning: 0.3, reflex: -2.5, handling: -3.5 };

  const player = {
    name: randomYouthName(),
    number: 30 + Math.floor(Math.random() * 60),
    age,
    pos,
    naturalPos: pos,
    baseQuality: quality,
    basePotential: potential,
    pace: sk(mods.pace, ["FL","FR","ML","MR","DL","DR"].includes(p)),
    passing: sk(mods.passing, ["MC","OMC","DM","ML","MR"].includes(p)),
    finishing: sk(mods.finishing, ["FC","FL","FR","OMC"].includes(p)),
    tackle: sk(mods.tackle, ["DC","DL","DR","DM"].includes(p)),
    vision: sk(mods.vision, ["MC","OMC","DM"].includes(p)),
    stamina: sk(mods.stamina, true),
    strength: sk(mods.strength, ["DC","FC","DM"].includes(p)),
    technique: sk(mods.technique, ["OMC","MC","FL","FR","FC"].includes(p)),
    agility: sk(mods.agility, isGk || ["FL","FR","ML","MR"].includes(p)),
    positioning: sk(mods.positioning, isGk || ["DC","DL","DR","DM","FC"].includes(p)),
    reflex: isGk ? sk(mods.reflex, true) : Math.max(3, Math.min(8, sk(-3, false))),
    handling: isGk ? sk(mods.handling, true) : Math.max(2, Math.min(7, sk(-3.5, false))),
    condition: 90,
    form: 0,
    experience: 1,
    happiness: 85,
    fromAcademy: true,
  };
  if (preferredSkill && player[preferredSkill] !== undefined) {
    const boost = 4 + Math.random() * 3 + (scoutLevel || 1) * 0.5;
    player[preferredSkill] = Math.min(
      18,
      Math.max(Number(player[preferredSkill]) || 8, cur + boost),
    );
  }
  return player;
}

async function drawPlayer(clubId, opts) {
  opts = opts || {};
  if (typeof deps.getTeam !== "function" || typeof deps.saveTeam !== "function") {
    return { ok: false, error: "Takım depolama yapılandırılmadı" };
  }
  const s = await loadState(clubId);
  const max = s.maxDrawsPerSeason || DEFAULT_MAX_DRAWS_PER_SEASON;
  if ((s.drawsThisSeason || 0) >= max) {
    return {
      ok: false,
      error:
        "Sezonluk keşif hakkı doldu (" +
        (s.drawsThisSeason || 0) +
        "/" +
        max +
        "). Yeni sezonda hak yenilenir.",
    };
  }

  const team = await _call(deps.getTeam, clubId);
  if (!team) return { ok: false, error: "Takım yok" };

  const player = generatePlayer(
    s.scoutLevel || 1,
    s.academyLevel || 1,
    opts.preferredFamily || null,
    opts.preferredSkill || null,
  );
  team.bench = team.bench || [];
  team.bench.push(player);
  await _call(deps.saveTeam, clubId, team);

  s.drawsThisSeason = (s.drawsThisSeason || 0) + 1;
  s.lastDrawWeekKey = weekKeyNow();
  s.recent.unshift({
    name: player.name,
    pos: player.pos,
    age: player.age,
    at: Date.now(),
  });
  if (s.recent.length > 20) s.recent.length = 20;
  await persist(clubId, s);

  try {
    await youthRepo.addDiscovery(clubId, player);
  } catch (e) {
    deps.log && deps.log("[youth] addDiscovery", e.message);
  }

  deps.log && deps.log("[youth] draw", clubId, player.name, player.pos);
  return { ok: true, player, state: publicState(s) };
}

async function upgrade(clubId, kind) {
  if (kind !== "scout" && kind !== "academy") {
    return { ok: false, error: "Geçersiz yükseltme türü" };
  }
  const s = await loadState(clubId);
  const isScout = kind === "scout";
  const level = isScout ? s.scoutLevel || 1 : s.academyLevel || 1;
  const maxLevel = isScout ? MAX_SCOUT_LEVEL : MAX_ACADEMY_LEVEL;
  const pending = isScout ? s.pendingScoutLevel : s.pendingAcademyLevel;
  const label = isScout ? "Scout" : "Akademi";

  if (level >= maxLevel) return { ok: false, error: label + " zaten maksimum seviyede." };
  if (pending) return { ok: false, error: label + " yükseltmesi devam ediyor…" };

  const cost = isScout ? scoutUpgradeCost(level) : academyUpgradeCost(level);
  if (typeof deps.adjustBalance === "function") {
    const okBal = await _call(deps.adjustBalance, clubId, -cost, label + " yükseltme");
    if (!okBal) return { ok: false, error: "Yetersiz bütçe" };
  }

  const until = Date.now() + upgradeDurationMs(level);
  if (isScout) {
    s.pendingScoutLevel = level + 1;
    s.scoutUpgradeUntil = until;
  } else {
    s.pendingAcademyLevel = level + 1;
    s.academyUpgradeUntil = until;
  }
  await persist(clubId, s);
  deps.log && deps.log("[youth] upgrade start", clubId, kind, "→", level + 1);
  return { ok: true, state: publicState(s), cost };
}

async function resetAllSeasonDraws() {
  for (const [clubId, s] of store.entries()) {
    s.drawsThisSeason = 0;
    s.lastDrawWeekKey = "";
    try {
      await persist(clubId, s);
    } catch (e) {}
  }
}

async function tickAll() {
  const now = Date.now();
  for (const [clubId, s] of store.entries()) {
    let changed = false;
    if (s.pendingScoutLevel && s.scoutUpgradeUntil && now >= s.scoutUpgradeUntil) {
      s.scoutLevel = s.pendingScoutLevel;
      s.pendingScoutLevel = null;
      s.scoutUpgradeUntil = 0;
      changed = true;
    }
    if (s.pendingAcademyLevel && s.academyUpgradeUntil && now >= s.academyUpgradeUntil) {
      s.academyLevel = s.pendingAcademyLevel;
      s.pendingAcademyLevel = null;
      s.academyUpgradeUntil = 0;
      changed = true;
    }
    if (changed) {
      try {
        await persist(clubId, s);
        deps.log && deps.log("[youth] upgrade complete", clubId);
      } catch (e) {}
    }
  }
}

let _timer = null;
function startUpgradeTimer(ms) {
  if (_timer) return;
  _timer = setInterval(() => {
    Promise.resolve(tickAll()).catch((e) => {
      console.error("[youth] tick", e);
    });
  }, ms || 5000);
}

module.exports = {
  configure,
  getState,
  drawPlayer,
  upgrade,
  resetAllSeasonDraws,
  startUpgradeTimer,
  scoutUpgradeCost,
  academyUpgradeCost,
  MAX_SCOUT_LEVEL,
  MAX_ACADEMY_LEVEL,
};
