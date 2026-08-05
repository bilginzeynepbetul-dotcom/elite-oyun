// ============================================================
// stadiumSystem.js — SUNUCU TARAFLI STADYUM (async DB)
// ============================================================

const DEFAULT_CAPACITY = 24500;
const DEFAULT_TICKET = 12;
const SEAT_UPGRADE_AMOUNT = 1000;
const SEAT_UPGRADE_COST = 45000;
const MAX_CAPACITY = 120000;
const MIN_TICKET = 5;
const MAX_TICKET = 80;

const store = new Map();

let deps = {
  getClub: null,
  adjustBalance: null,
  getStadiumState: null,
  saveStadiumState: null,
  getTeamName: null,
  log: console.log,
};

function configure(next) {
  deps = Object.assign(deps, next || {});
}

async function _call(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  return await Promise.resolve(fn(...args));
}

async function defaultState(clubId) {
  let name = "Arena";
  if (typeof deps.getTeamName === "function") {
    try {
      const tn = await _call(deps.getTeamName, clubId);
      if (tn) name = tn + " Arena";
    } catch (e) {}
  }
  return {
    name,
    capacity: DEFAULT_CAPACITY,
    ticketPrice: DEFAULT_TICKET,
    seatUpgradeCost: SEAT_UPGRADE_COST,
    totalUpgrades: 0,
  };
}

async function loadState(clubId) {
  if (store.has(clubId)) return store.get(clubId);
  let s = null;
  if (typeof deps.getStadiumState === "function") {
    try {
      s = await _call(deps.getStadiumState, clubId);
    } catch (e) {}
  }
  if (!s) s = await defaultState(clubId);
  store.set(clubId, s);
  return s;
}

async function persist(clubId, s) {
  store.set(clubId, s);
  if (typeof deps.saveStadiumState === "function") {
    try {
      await _call(deps.saveStadiumState, clubId, s);
    } catch (e) {}
  }
}

function publicState(s) {
  return {
    name: s.name,
    capacity: s.capacity,
    ticketPrice: s.ticketPrice,
    seatUpgradeCost: s.seatUpgradeCost || SEAT_UPGRADE_COST,
    totalUpgrades: s.totalUpgrades || 0,
    maxCapacity: MAX_CAPACITY,
    canUpgrade: (s.capacity || 0) + SEAT_UPGRADE_AMOUNT <= MAX_CAPACITY,
  };
}

async function getState(clubId) {
  return publicState(await loadState(clubId));
}

async function upgradeSeats(clubId) {
  const s = await loadState(clubId);
  if ((s.capacity || 0) + SEAT_UPGRADE_AMOUNT > MAX_CAPACITY) {
    return { ok: false, error: "Maksimum kapasiteye ulaşıldı" };
  }
  const cost = s.seatUpgradeCost || SEAT_UPGRADE_COST;
  if (typeof deps.adjustBalance === "function") {
    const ok = await _call(
      deps.adjustBalance,
      clubId,
      -cost,
      "Stadyum koltuk +1000",
    );
    if (!ok) return { ok: false, error: "Yetersiz bütçe" };
  }
  s.capacity = (s.capacity || DEFAULT_CAPACITY) + SEAT_UPGRADE_AMOUNT;
  s.totalUpgrades = (s.totalUpgrades || 0) + 1;
  await persist(clubId, s);
  deps.log && deps.log("[stadium] upgrade", clubId, s.capacity);
  return { ok: true, state: publicState(s), cost };
}

async function setTicketPrice(clubId, price) {
  price = Math.floor(Number(price) || 0);
  if (price < MIN_TICKET || price > MAX_TICKET) {
    return {
      ok: false,
      error: "Bilet fiyatı " + MIN_TICKET + "–" + MAX_TICKET + " € olmalı",
    };
  }
  const s = await loadState(clubId);
  s.ticketPrice = price;
  await persist(clubId, s);
  return { ok: true, state: publicState(s) };
}

async function renameStadium(clubId, name) {
  name = String(name || "").trim().slice(0, 40);
  if (name.length < 3) return { ok: false, error: "İsim en az 3 karakter" };
  const s = await loadState(clubId);
  s.name = name;
  await persist(clubId, s);
  return { ok: true, state: publicState(s) };
}

async function applyMatchTicketRevenue(clubId, opts) {
  opts = opts || {};
  const s = await loadState(clubId);
  const isHome = opts.isHome !== false;
  const comp = opts.comp || "lig";

  if (!isHome) {
    return {
      tickets: 0,
      attendance: 0,
      label: "Deplasman — bilet geliri yok",
      isHome: false,
    };
  }

  const attendance = Math.min(
    s.capacity,
    Math.floor(s.capacity * (0.55 + Math.random() * 0.4)),
  );
  let gate = attendance * (s.ticketPrice || DEFAULT_TICKET);
  let label = "Lig bilet geliri";
  if (comp === "kupa" || comp === "dostluk") {
    gate = Math.round(gate / 2);
    label =
      (comp === "kupa" ? "Kupa" : "Dostluk") + " bilet (eşit paylaşım)";
  }

  if (typeof deps.adjustBalance === "function") {
    await _call(
      deps.adjustBalance,
      clubId,
      gate,
      label + " (" + attendance.toLocaleString("tr-TR") + " seyirci)",
    );
  }

  return {
    tickets: gate,
    attendance,
    label,
    isHome: true,
  };
}

module.exports = {
  configure,
  getState,
  upgradeSeats,
  setTicketPrice,
  renameStadium,
  applyMatchTicketRevenue,
  SEAT_UPGRADE_COST,
  SEAT_UPGRADE_AMOUNT,
};
