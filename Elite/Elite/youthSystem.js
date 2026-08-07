// ============================================================
// youthSystem.js — SUNUCU TARAFLI ALTYAPI / AKADEMİ
// ------------------------------------------------------------
// Kulüp bazlı scout/akademi seviyesi, haftalık çekim, yükseltme.
// configure({ getClub, adjustBalance, getTeam, saveTeam, getYouthState,
//             saveYouthState }) ile bağlanır.
// ============================================================

const crypto = require("crypto");

const MAX_SCOUT = 5;
const MAX_ACADEMY = 5;
const MAX_DRAWS_PER_SEASON = 12;
const UPGRADE_DURATION_MS = 90 * 1000; // online'da da aynı tempo; istersen artır

/** clubId → youth state (bellek; kalıcılık saveYouthState ile) */
const store = new Map();

let deps = {
  getClub: null,
  adjustBalance: null,
  getTeam: null,
  saveTeam: null,
  /** optional persistence hooks */
  getYouthState: null, // (clubId) => state|null
  saveYouthState: null, // (clubId, state) => void
  log: console.log,
};

function configure(next) {
  deps = Object.assign(deps, next || {});
}

async function _call(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  return await Promise.resolve(fn(...args));
}

function uid(prefix) {
  return (
    (prefix || "y") +
    "_" +
    crypto.randomBytes(5).toString("hex") +
    "_" +
    Date.now().toString(36)
  );
}

function weekKeyNow(ts) {
  const d = ts ? new Date(ts) : new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + weekNo;
}

function defaultState() {
  return {
    scoutLevel: 1,
    academyLevel: 1,
    maxScout: MAX_SCOUT,
    maxAcademy: MAX_ACADEMY,
    drawsThisSeason: 0,
    maxDrawsPerSeason: MAX_DRAWS_PER_SEASON,
    lastDrawWeekKey: "",
    scoutUpgradeUntil: 0,
    academyUpgradeUntil: 0,
    pendingScoutLevel: null,
    pendingAcademyLevel: null,
    /** Son keşfedilenler (UI roster) */
    recent: [],
  };
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

function applyPendingUpgrades(s) {
  const now = Date.now();
  let changed = false;
  if (s.pendingScoutLevel && s.scoutUpgradeUntil && now >= s.scoutUpgradeUntil) {
    s.scoutLevel = s.pendingScoutLevel;
    s.pendingScoutLevel = null;
    s.scoutUpgradeUntil = 0;
    changed = true;
  }
  if (
    s.pendingAcademyLevel &&
    s.academyUpgradeUntil &&
    now >= s.academyUpgradeUntil
  ) {
    s.academyLevel = s.pendingAcademyLevel;
    s.pendingAcademyLevel = null;
    s.academyUpgradeUntil = 0;
    changed = true;
  }
  return changed;
}

function scoutUpgradeCost(level) {
  return 150000 * level;
}
function academyUpgradeCost(level) {
  return 200000 * level;
}

function generateYouthPlayer(state, preferredSkill) {
  let positions = [
    "GK",
    "DL",
    "DR",
    "DC",
    "DM",
    "MC",
    "ML",
    "MR",
    "OMC",
    "FL",
    "FC",
    "FR",
  ];
  if (preferredSkill === "reflex" || preferredSkill === "handling") {
    positions = ["GK"];
  } else if (preferredSkill === "finishing") {
    positions = ["FC", "FL", "FR", "OMC"];
  } else if (preferredSkill === "tackle") {
    positions = ["DC", "DL", "DR", "DM"];
  } else if (preferredSkill === "passing" || preferredSkill === "vision") {
    positions = ["MC", "DM", "OMC", "ML", "MR"];
  }
  const pos = positions[Math.floor(Math.random() * positions.length)];
  const scoutBonus = ((state.scoutLevel || 1) - 1) * 0.6;
  const acadBonus = ((state.academyLevel || 1) - 1) * 0.5;
  let quality = Math.round(1 + Math.random() * 3.5 + scoutBonus * 0.4);
  let potential = Math.round(3 + Math.random() * 6 + acadBonus + scoutBonus * 0.5);
  quality = Math.max(1, Math.min(10, quality));
  potential = Math.max(quality, Math.min(10, potential));

  const first = [
    "Yiğit",
    "Efe",
    "Miraç",
    "Alp",
    "Kaan",
    "Deniz",
    "Onur",
    "Baran",
    "Emir",
    "Umut",
    "Çınar",
    "Rüzgar",
  ];
  const last = [
    "Yılmaz",
    "Demir",
    "Kaya",
    "Çelik",
    "Aydın",
    "Öztürk",
    "Arslan",
    "Şahin",
    "Koç",
    "Polat",
  ];
  const base = 6 + quality * 0.8 + Math.random() * 2;
  const skill = () =>
    Math.max(5, Math.min(16, Math.round(base + (Math.random() - 0.5) * 3)));

  const p = {
    id: uid("yp"),
    name:
      first[Math.floor(Math.random() * first.length)] +
      " " +
      last[Math.floor(Math.random() * last.length)],
    pos,
    naturalPos: pos,
    age: 15 + Math.floor(Math.random() * 4), // 15–18
    number: 30 + Math.floor(Math.random() * 40),
    pace: skill(),
    passing: skill(),
    finishing: skill(),
    tackle: skill(),
    vision: skill(),
    stamina: skill(),
    strength: skill(),
    technique: skill(),
    agility: skill(),
    positioning: skill(),
    reflex: skill(),
    handling: skill(),
    condition: 88 + Math.floor(Math.random() * 10),
    form: 0,
    experience: 0.5 + Math.random() * 1.5,
    happiness: 80 + Math.floor(Math.random() * 15),
    minutesPlayed: 0,
    goals: 0,
    assists: 0,
    keyActions: 0,
    saves: 0,
    cards: 0,
    sentOff: false,
    fromAcademy: true,
    fromMarket: false,
    baseQuality: quality,
    basePotential: potential,
  };

  // Tercih edilen skill'i biraz öne çıkar
  if (preferredSkill && p[preferredSkill] != null) {
    p[preferredSkill] = Math.min(18, p[preferredSkill] + 2 + Math.floor(Math.random() * 2));
  }
  return p;
}

function publicState(s) {
  applyPendingUpgrades(s);
  return {
    scoutLevel: s.scoutLevel,
    academyLevel: s.academyLevel,
    maxScout: s.maxScout || MAX_SCOUT,
    maxAcademy: s.maxAcademy || MAX_ACADEMY,
    drawsThisSeason: s.drawsThisSeason || 0,
    maxDrawsPerSeason: s.maxDrawsPerSeason || MAX_DRAWS_PER_SEASON,
    lastDrawWeekKey: s.lastDrawWeekKey || "",
    canDrawThisWeek: (s.lastDrawWeekKey || "") !== weekKeyNow(),
    scoutUpgradeUntil: s.scoutUpgradeUntil || 0,
    academyUpgradeUntil: s.academyUpgradeUntil || 0,
    pendingScoutLevel: s.pendingScoutLevel,
    pendingAcademyLevel: s.pendingAcademyLevel,
    scoutUpgradeCost:
      s.scoutLevel < MAX_SCOUT ? scoutUpgradeCost(s.scoutLevel) : null,
    academyUpgradeCost:
      s.academyLevel < MAX_ACADEMY ? academyUpgradeCost(s.academyLevel) : null,
    recent: (s.recent || []).slice(0, 20),
    weekKey: weekKeyNow(),
  };
}

async function getState(clubId) {
  const s = await loadState(clubId);
  if (applyPendingUpgrades(s)) await persist(clubId, s);
  return publicState(s);
}

async function drawPlayer(clubId, preferredSkill) {
  const s = await loadState(clubId);
  applyPendingUpgrades(s);

  if ((s.lastDrawWeekKey || "") === weekKeyNow()) {
    return { ok: false, error: "Bu hafta altyapı hakkı kullanıldı" };
  }
  if ((s.drawsThisSeason || 0) >= (s.maxDrawsPerSeason || MAX_DRAWS_PER_SEASON)) {
    return { ok: false, error: "Sezonluk keşif hakkı doldu" };
  }

  const player = generateYouthPlayer(s, preferredSkill || null);
  s.drawsThisSeason = (s.drawsThisSeason || 0) + 1;
  s.lastDrawWeekKey = weekKeyNow();
  s.recent = s.recent || [];
  s.recent.unshift({
    id: player.id,
    name: player.name,
    pos: player.pos,
    age: player.age,
    at: Date.now(),
  });
  if (s.recent.length > 30) s.recent.length = 30;

  if (typeof deps.getTeam === "function" && typeof deps.saveTeam === "function") {
    const team = await _call(deps.getTeam, clubId);
    if (team) {
      team.bench = team.bench || [];
      team.bench.push(player);
      await _call(deps.saveTeam, clubId, team);
    }
  }

  await persist(clubId, s);
  deps.log && deps.log("[youth] draw", clubId, player.name, player.pos);
  return { ok: true, player, state: publicState(s) };
}

async function startUpgrade(clubId, kind) {
  const s = await loadState(clubId);
  applyPendingUpgrades(s);

  if (kind === "scout") {
    if (s.scoutLevel >= MAX_SCOUT)
      return { ok: false, error: "Scout zaten maksimum" };
    if (s.pendingScoutLevel)
      return { ok: false, error: "Scout yükseltmesi devam ediyor" };
    const cost = scoutUpgradeCost(s.scoutLevel);
    if (typeof deps.adjustBalance === "function") {
      const ok = await _call(deps.adjustBalance, clubId, -cost, "Scout yükseltme");
      if (!ok) return { ok: false, error: "Yetersiz kasa" };
    }
    s.pendingScoutLevel = s.scoutLevel + 1;
    s.scoutUpgradeUntil = Date.now() + UPGRADE_DURATION_MS;
    await persist(clubId, s);
    return {
      ok: true,
      cost,
      until: s.scoutUpgradeUntil,
      state: publicState(s),
    };
  }

  if (kind === "academy") {
    if (s.academyLevel >= MAX_ACADEMY)
      return { ok: false, error: "Akademi zaten maksimum" };
    if (s.pendingAcademyLevel)
      return { ok: false, error: "Akademi yükseltmesi devam ediyor" };
    const cost = academyUpgradeCost(s.academyLevel);
    if (typeof deps.adjustBalance === "function") {
      const ok = await _call(deps.adjustBalance, clubId, -cost, "Akademi yükseltme");
      if (!ok) return { ok: false, error: "Yetersiz kasa" };
    }
    s.pendingAcademyLevel = s.academyLevel + 1;
    s.academyUpgradeUntil = Date.now() + UPGRADE_DURATION_MS;
    await persist(clubId, s);
    return {
      ok: true,
      cost,
      until: s.academyUpgradeUntil,
      state: publicState(s),
    };
  }

  return { ok: false, error: "Geçersiz yükseltme türü" };
}

/** Sezon reset (lig sezonu bitince çağır) */
async function resetSeasonDraws(clubId) {
  const s = await loadState(clubId);
  s.drawsThisSeason = 0;
  s.lastDrawWeekKey = "";
  await persist(clubId, s);
  return publicState(s);
}

function resetAllSeasonDraws() {
  for (const clubId of store.keys()) resetSeasonDraws(clubId);
}

/** Pending upgrade tick — timer ile */
let _timer = null;
function startUpgradeTimer(ms) {
  if (_timer) return;
  _timer = setInterval(() => {
    for (const [clubId, s] of store.entries()) {
      if (applyPendingUpgrades(s)) {
        Promise.resolve(persist(clubId, s)).catch((e) =>
          console.error("[youth] persist", e.message),
        );
      }
    }
  }, ms || 5000);
}

module.exports = {
  configure,
  getState,
  drawPlayer,
  startUpgrade,
  resetSeasonDraws,
  resetAllSeasonDraws,
  startUpgradeTimer,
  weekKeyNow,
  UPGRADE_DURATION_MS,
};
