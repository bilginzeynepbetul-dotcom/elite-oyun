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
// A Milli + U21: sezonda haftada 1 dostluk maçı (lig ~9 hafta / 18 maç)
const FIXTURE_GAP_DAYS = 7;

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

async function ensureTeam(country, category) {
  const cat = nationalRepo.normCategory
    ? nationalRepo.normCategory(category)
    : (String(category || "A").toUpperCase() === "U21" ? "U21" : "A");
  let team = await nationalRepo.getTeamByCountry(country, cat);
  return team;
}

/** Sadece .env'deki ADMIN_USERNAME ile eşleşen hesap TD ataması yapabilir. */
function isAdmin(username) {
  const adminName = process.env.ADMIN_USERNAME;
  return !!adminName && !!username && username.toLowerCase() === adminName.toLowerCase();
}

async function getState(country, userId, clubId, username, category) {
  const team = await ensureTeam(country, category);
  if (!team) return null;
  const cat = team.category || (String(category || "A").toUpperCase() === "U21" ? "U21" : "A");
  const maxAge = cat === "U21" ? 21 : null;
  const [squad, candidatesRaw, nextFixture, recent, myApplication] = await Promise.all([
    nationalRepo.getSquad(team.id),
    nationalRepo.listCandidates(country, team.id, maxAge),
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
      category: cat,
      formation: team.formation,
      passStyle: team.passStyle,
      gameStyle: team.gameStyle,
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

async function apply(country, userId, clubId, message, username, category) {
  if (!clubId) return { ok: false, error: "Önce kendi kulübün olmalı" };
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  // A + U21: herkes başvurur; atama sadece ADMIN_USERNAME (murat).
  if (team.managerUserId) {
    return { ok: false, error: "Bu koltuk dolu — önce mevcut TD ayrılmalı" };
  }
  const result = await nationalRepo.applyForManager(
    team.id,
    userId,
    clubId,
    message,
  );
  try {
    const socialSystem = require("./socialSystem");
    const { query } = require("./db");
    const adminName = process.env.ADMIN_USERNAME;
    if (adminName && result && result.ok) {
      const { rows } = await query(
        `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
        [adminName],
      );
      if (rows[0]) {
        const cat = team.category || category || "A";
        await socialSystem.pushNotification(
          rows[0].id,
          "🏳️",
          (username || "?") +
            " · " +
            (team.country || "") +
            " " +
            cat +
            " milli TD başvurusu",
          "Milli Takım",
        );
      }
    }
  } catch (e) {
    console.warn("[national] admin notify", e.message);
  }
  return result;
}

async function withdrawApplication(country, userId, category) {
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.withdrawApplication(team.id, userId);
}

async function listApplications(country, username, category) {
  if (!isAdmin(username)) return { ok: false, error: "Bu işlem için yetkin yok" };
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  const applications = await nationalRepo.listApplications(team.id, "pending");
  return { ok: true, applications };
}

async function appoint(country, username, applicationId, category) {
  if (!isAdmin(username)) return { ok: false, error: "Bu işlem için yetkin yok" };
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.appointFromApplication(team.id, applicationId);
}

async function claim(country, userId, clubId, category) {
  if (!clubId) return { ok: false, error: "Önce kendi kulübün olmalı" };
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.claimManager(team.id, userId, clubId);
}

async function resign(country, userId, category) {
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  return nationalRepo.resignManager(team.id, userId);
}

async function requireManager(country, userId, category) {
  const team = await ensureTeam(country, category);
  if (!team) return { ok: false, error: "Milli takım bulunamadı" };
  if (team.managerUserId !== userId) {
    return { ok: false, error: "Bu işlem için teknik direktör olman gerekiyor" };
  }
  return { ok: true, team };
}

async function callUp(country, userId, playerId, category) {
  const chk = await requireManager(country, userId, category);
  if (!chk.ok) return chk;
  const maxAge = (chk.team.category === "U21") ? 21 : null;
  const candidates = await nationalRepo.listCandidates(country, chk.team.id, maxAge);
  const found = candidates.find((c) => c.playerId === playerId);
  if (!found) return { ok: false, error: "Oyuncu aday havuzunda değil" };
  return nationalRepo.callUpPlayer(chk.team.id, playerId, found.clubId);
}

async function drop(country, userId, playerId, category) {
  const chk = await requireManager(country, userId, category);
  if (!chk.ok) return chk;
  return nationalRepo.dropPlayer(chk.team.id, playerId);
}

async function saveLineup(country, userId, starterPlayerIds, formation, assignments, passStyle, gameStyle, category) {
  const chk = await requireManager(country, userId, category);
  if (!chk.ok) return chk;
  return nationalRepo.setLineup(
    chk.team.id,
    starterPlayerIds,
    formation,
    assignments,
    passStyle,
    gameStyle,
  );
}

// Sadece pozisyon etiketleri — server tarafında x/y'ye gerek yok
// (matchEngine.js sadece p.pos kullanıyor). index.html'deki
// FORMATION_PRESETS ile aynı pozisyon sırası.
const AUTO_FORMATIONS = {
  "4-4-2": ["GK", "DL", "DC", "DC", "DR", "ML", "MC", "MC", "MR", "FL", "FR"],
  "4-3-3": ["GK", "DL", "DC", "DC", "DR", "MC", "MC", "MC", "FL", "FC", "FR"],
  "4-2-3-1": ["GK", "DL", "DC", "DC", "DR", "DM", "DM", "ML", "OMC", "MR", "FC"],
  "3-5-2": ["GK", "DC", "DC", "DC", "ML", "MC", "DM", "MC", "MR", "FL", "FR"],
  "5-3-2": ["GK", "DL", "DC", "DC", "DC", "DR", "MC", "MC", "MC", "FL", "FR"],
};
const AUTO_FALLBACK_FORMATION = "4-4-2";

/**
 * TD kadroyu/ilk 11'i maç saatine kadar belirlemezse, yapay zeka devreye
 * girer: eksikse en kaliteli uygun oyunculardan kadroyu tamamlar ve mevcut
 * kadrodan (varsa) en iyi 11'i, yoksa yeni çağrılanları, formasyona göre
 * ilk 11'e yerleştirir. Zaten geçerli bir ilk 11 varsa dokunmaz.
 */
async function autoFillSquadForMatch(team) {
  if (!team) return;
  let squad = await nationalRepo.getSquad(team.id);
  if (squad.filter((p) => p.isStarter).length >= 11) return; // TD zaten hazırlamış

  const maxAge = team.category === "U21" ? 21 : null;
  if (squad.length < 11) {
    const candidatesRaw = await nationalRepo.listCandidates(team.country, team.id, maxAge);
    const pool = candidatesRaw.filter((c) => !c.called);
    for (const cand of pool) {
      if (squad.length >= 11) break;
      const res = await nationalRepo.callUpPlayer(team.id, cand.playerId, cand.clubId);
      if (res && res.ok) squad.push({ ...cand, isStarter: false });
    }
  }
  if (squad.length < 11) return; // ülkede yeterli uygun oyuncu yok — elden bir şey gelmez

  const formation =
    team.formation && AUTO_FORMATIONS[team.formation]
      ? team.formation
      : AUTO_FALLBACK_FORMATION;
  const slots = AUTO_FORMATIONS[formation];

  const ranked = [...squad].sort((a, b) => (b.overall || 0) - (a.overall || 0));
  const used = new Set();
  const finalAssignments = [];

  // 1) Her slota, doğal mevkisi uyan en kaliteli müsait oyuncuyu yerleştir.
  slots.forEach((pos) => {
    const match = ranked.find(
      (p) => !used.has(p.playerId) && (p.naturalPos || p.pos) === pos,
    );
    if (match) {
      used.add(match.playerId);
      finalAssignments.push({ playerId: match.playerId, pos });
    }
  });
  // 2) Doğal mevkisi uymayan kalan boş slotları, kalan en kaliteli
  //    oyuncularla (kaleci hariç GK slotuna kaleci olmayan konmaz) doldur.
  const leftovers = ranked.filter((p) => !used.has(p.playerId));
  slots.forEach((pos) => {
    if (finalAssignments.some((a) => a.pos === pos)) return;
    const idx = leftovers.findIndex((p) =>
      !used.has(p.playerId) && (pos !== "GK" || (p.naturalPos || p.pos) === "GK"),
    );
    const pick = idx !== -1 ? leftovers[idx] : leftovers.find((p) => !used.has(p.playerId));
    if (pick) {
      used.add(pick.playerId);
      finalAssignments.push({ playerId: pick.playerId, pos });
    }
  });

  const starterPlayerIds = finalAssignments.map((a) => a.playerId);
  await nationalRepo.setLineup(
    team.id,
    starterPlayerIds,
    formation,
    finalAssignments,
    team.passStyle || "kisa",
    team.gameStyle || "dengeli",
  );

  try {
    if (team.managerUserId) {
      const socialSystem = require("./socialSystem");
      await socialSystem.pushNotification(
        team.managerUserId,
        "🤖",
        `Kadro/ilk 11 belirlenmediği için ${team.country} ${team.category} kadrosunu yapay zeka otomatik oluşturdu.`,
        "Milli Takım",
      );
    }
  } catch (e) {
    console.warn("[national] autoFillSquadForMatch notify", e.message);
  }
}

/**
 * Sıradaki maç yoksa yeni bir dostluk maçı açar (rastgele dünya rakibi).
 * A Milli ve U21 için ayrı kadro / fikstür zinciri.
 */
async function scheduleNextFixtureIfNeeded(country, category) {
  const team = await ensureTeam(country, category);
  if (!team) return null;
  const existing = await nationalRepo.getUpcomingFixture(team.id);
  if (existing) return existing;

  const [name, strength] =
    OPPONENT_NAMES[Math.floor(Math.random() * OPPONENT_NAMES.length)];
  // U21 rakipleri biraz daha zayıf tutulur
  const cat = team.category || (String(category || "A").toUpperCase() === "U21" ? "U21" : "A");
  const adjStrength =
    cat === "U21" ? Math.max(50, Math.round(strength * 0.88)) : strength;
  const label = cat === "U21" ? name + " U21" : name;

  const kickoffAt = NAT_INTERVAL_MS
    ? new Date(Date.now() + NAT_INTERVAL_MS)
    : nextThursday21(Date.now());

  return nationalRepo.createFixture(team.id, label, adjStrength, kickoffAt);
}

/** A + U21 için sıradaki dostlukları doldurur (scheduler tick). */
async function ensureAllNationalFixtures(country) {
  const out = [];
  for (const cat of ["A", "U21"]) {
    try {
      const fx = await scheduleNextFixtureIfNeeded(country, cat);
      if (fx) out.push({ category: cat, fixtureId: fx.id || fx.fixtureId || null });
    } catch (e) {
      console.warn("[national] ensure fixture", cat, e.message);
    }
  }
  return out;
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
  autoFillSquadForMatch,
  scheduleNextFixtureIfNeeded,
  ensureAllNationalFixtures,
  OPPONENT_NAMES,
};
