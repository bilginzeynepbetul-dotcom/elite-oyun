// ============================================================
// stadiumSystem.js — kapasite / bilet / isim
// ============================================================

const stadiumRepo = require("./repos/stadiumRepo");
const clubsRepo = require("./repos/clubsRepo");
const economy = require("./economyBalance");

async function ensureStadium(clubId, clubName) {
  let state = await stadiumRepo.getStadiumState(clubId);
  if (state) return state;
  state = {
    name: (clubName || "Kulüp") + " Arena",
    capacity: 24500,
    ticketPrice: 12,
    seatUpgradeCost: economy.STADIUM
      ? economy.STADIUM.baseUpgrade || 45000
      : 45000,
    totalUpgrades: 0,
  };
  await stadiumRepo.saveStadiumState(clubId, state);
  return state;
}

async function getState(clubId) {
  const club = await clubsRepo.getClub(clubId);
  return ensureStadium(clubId, club && club.name);
}

async function upgradeSeats(clubId) {
  const state = await getState(clubId);
  const cost =
    typeof economy.stadiumUpgradeCost === "function"
      ? economy.stadiumUpgradeCost(state.totalUpgrades || 0)
      : Math.round((state.seatUpgradeCost || 45000) * Math.pow(1.08, state.totalUpgrades || 0));

  const ok = await clubsRepo.adjustBalance(clubId, -cost, "Stadyum kapasite yükseltme");
  if (!ok) return { ok: false, error: "Yetersiz bakiye", cost };

  const add = 1000;
  state.capacity = Math.min(120000, (state.capacity || 24500) + add);
  state.totalUpgrades = (state.totalUpgrades || 0) + 1;
  state.seatUpgradeCost = Math.round(cost * 1.08);
  await stadiumRepo.saveStadiumState(clubId, state);
  return { ok: true, state, cost };
}

async function setTicketPrice(clubId, price) {
  const state = await getState(clubId);
  const p = Math.max(5, Math.min(80, Math.round(Number(price) || 12)));
  state.ticketPrice = p;
  await stadiumRepo.saveStadiumState(clubId, state);
  return { ok: true, state };
}

async function rename(clubId, name) {
  const state = await getState(clubId);
  const n = String(name || "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 64);
  if (!n) return { ok: false, error: "İsim gerekli" };
  state.name = n;
  await stadiumRepo.saveStadiumState(clubId, state);
  return { ok: true, state };
}

/** Maç sonrası bilet geliri (matchLifecycle) */
async function applyTicketRevenue(clubId, opts) {
  if (!clubId) return { ok: false };
  const state = await getState(clubId);
  const capacity = state.capacity || 24500;
  const price = state.ticketPrice || 12;
  const isHome = opts && opts.isHome !== false;
  if (!isHome) return { ok: true, amount: 0 };

  let fill = 0.55;
  const result = opts && opts.result; // win|draw|loss
  if (result === "win") fill = 0.78;
  else if (result === "draw") fill = 0.62;
  else if (result === "loss") fill = 0.48;
  const kind = (opts && (opts.kind || opts.comp)) || "league";
  if (kind === "continental" || kind === "kitasal") fill = Math.min(0.95, fill * 1.25);
  if (kind === "cup" || kind === "kupa") fill = Math.min(0.92, fill * 1.1);

  const attendance = Math.floor(capacity * fill);
  const amount = attendance * price;
  await clubsRepo.adjustBalance(clubId, amount, "Maç bilet geliri");
  return { ok: true, amount, attendance, tickets: amount };
}

module.exports = {
  applyMatchTicketRevenue: applyTicketRevenue,
  ensureStadium,
  getState,
  upgradeSeats,
  setTicketPrice,
  rename,
  applyTicketRevenue,
};
