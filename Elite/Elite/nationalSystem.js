// ============================================================
// nationalSystem.js — Milli takım iş mantığı
// ============================================================

const nationalRepo = require("./repos/nationalRepo");
const clubsRepo = require("./repos/clubsRepo");

const OPPONENT_NAMES = [
  ["Almanya", 78], ["Fransa", 80], ["İspanya", 79], ["İtalya", 76],
  ["Portekiz", 77], ["Hollanda", 75], ["Belçika", 74], ["İngiltere", 79],
  ["Hırvatistan", 72], ["Sırbistan", 68], ["Polonya", 66], ["İsveç", 64],
  ["Danimarka", 67], ["İsviçre", 65], ["Avusturya", 63], ["Ukrayna", 62],
  ["Fas", 61], ["Mısır", 58], ["Senegal", 60], ["Japonya", 59],
  ["Güney Kore", 60], ["Brezilya", 82], ["Arjantin", 81], ["Kolombiya", 63],
];

const NAT_MATCH_DAY = 4; // Perşembe (Pazar=0)
const NAT_MATCH_HOUR = 21;
const FIXTURE_GAP_DAYS = 14; // iki milli maç arası (test ortamında NAT_INTERVAL_MS ile ezilebilir)

const NAT_INTERVAL_MS = process.env.NAT_INTERVAL_MS
  ? Number(process.env.NAT_INTERVAL_MS)
  : null; // test modu — HTML'deki Perşembe 21:00 slotunu es geçer

function nextThursday21(fromMs) {
  const d = new Date(fromMs);
  const day = d.getDay();
  let add = (NAT_MATCH_DAY - day + 7) % 7;
  if (add === 0 && d.getHours() >= NAT_MATCH_HOUR) add = 7;
  const target = new Date(d);
  target.setDate(d.getDate() + add);
  target.setHours(NAT_MATCH_HOUR, 0, 0, 0);
  return target;
}

async function ensureTeam(country) {
  let team = await nationalRepo.getTeamByCountry(country);
  return team;
}

/** Sadece .env'deki ADMIN_USERNAME ile eşleşen hesap TD ataması yapabilir. */
function isAdmin(username) {
  const adminName = process.env.ADMIN_USERNAME;
  return !!adminName && !!username && username.toLowerCase() === adminName.toLowerCase();
}

async function getState(country, userId, clubId, username) {
  const team = await ensureTeam(country);
  if (!team) return null;
  const [squad, candidatesRaw, nextFixture, recent, myApplication] = await Promise.all([
    nationalRepo.getSquad(team.id),
    nationalRepo.listCandidates(country, team.id),
    nationalRepo.getUpcomingFixture(team.id),
    nationalRepo.listRecentFixtures(team.id, 5),
    nationalRepo.getMyApplication(team.id, userId),
  ]);
  const candidates = candidatesRaw.filter((c) => !c.called);

  let managerName = null;
  if (team.managerClubId) {
    const c = await clubsRepo.getClub(team.managerClubId);
    managerName = c ? c.name : null;
  }

  return {
    team: {
      id: team.id,
      country: team.country,
      formation: team.formation,
      isManagerVacant: !team.managerUserId,
      isMeManager: team.managerUserId === userId,
      managerClubName: managerName,
    },
    squad,
    squadSize: squad.length,
    maxSquad: nationalRepo.MAX_SQUAD,
    candidates,
    nextFixture,
    recentFixtures: recent,
    myApplication,
    isAdmin: isAdmin(username),
  };
}

async function apply(country, userId, clubId, message) {
  if (!clubId) return { ok: false, error: "Önce kendi kulübün olmalı" };
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.applyForManager(team.id, userId, clubId, message);
}

async function withdrawApplication(country, userId) {
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.withdrawApplication(team.id, userId);
}

async function listApplications(country, username) {
  if (!isAdmin(username)) return { ok: false, error: "Bu işlem için yetkin yok" };
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  const applications = await nationalRepo.listApplications(team.id, "pending");
  return { ok: true, applications };
}

async function appoint(country, username, applicationId) {
  if (!isAdmin(username)) return { ok: false, error: "Bu işlem için yetkin yok" };
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.appointFromApplication(team.id, applicationId);
}

async function claim(country, userId, clubId) {
  if (!clubId) return { ok: false, error: "Önce kendi kulübün olmalı" };
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.claimManager(team.id, userId, clubId);
}

async function resign(country, userId) {
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.resignManager(team.id, userId);
}

async function requireManager(country, userId) {
  const team = await ensureTeam(country);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  if (team.managerUserId !== userId) {
    return { ok: false, error: "Bu işlem için teknik direktör olman gerekiyor" };
  }
  return { ok: true, team };
}

async function callUp(country, userId, playerId) {
  const chk = await requireManager(country, userId);
  if (!chk.ok) return chk;
  const candidates = await nationalRepo.listCandidates(country, chk.team.id);
  const found = candidates.find((c) => c.playerId === playerId);
  if (!found) return { ok: false, error: "Oyuncu aday havuzunda değil" };
  return nationalRepo.callUpPlayer(chk.team.id, playerId, found.clubId);
}

async function drop(country, userId, playerId) {
  const chk = await requireManager(country, userId);
  if (!chk.ok) return chk;
  return nationalRepo.dropPlayer(chk.team.id, playerId);
}

async function saveLineup(country, userId, starterPlayerIds, formation) {
  const chk = await requireManager(country, userId);
  if (!chk.ok) return chk;
  return nationalRepo.setLineup(chk.team.id, starterPlayerIds, formation);
}

/** Sıradaki maç yoksa yeni bir tane açar (rastgele "dünya" rakibi). */
async function scheduleNextFixtureIfNeeded(country) {
  const team = await ensureTeam(country);
  if (!team) return null;
  const existing = await nationalRepo.getUpcomingFixture(team.id);
  if (existing) return existing;

  const [name, strength] =
    OPPONENT_NAMES[Math.floor(Math.random() * OPPONENT_NAMES.length)];
  const kickoffAt = NAT_INTERVAL_MS
    ? new Date(Date.now() + NAT_INTERVAL_MS)
    : nextThursday21(Date.now());

  return nationalRepo.createFixture(team.id, name, strength, kickoffAt);
}

module.exports = {
  ensureTeam,
  getState,
  claim,
  resign,
  apply,
  withdrawApplication,
  listApplications,
  appoint,
  isAdmin,
  callUp,
  drop,
  saveLineup,
  scheduleNextFixtureIfNeeded,
  OPPONENT_NAMES,
};
