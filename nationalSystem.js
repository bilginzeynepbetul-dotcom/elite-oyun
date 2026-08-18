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
  // Balkan + İsrail
  ["İsrail", 64], ["Yunanistan", 62], ["Romanya", 60], ["Bulgaristan", 58],
  ["Bosna-Hersek", 59], ["Arnavutluk", 57], ["Kuzey Makedonya", 55],
  ["Karadağ", 54], ["Kosova", 53], ["Slovenya", 58],
];

const NAT_MATCH_DAY = 5; // Cuma (Pazar=0) — TR 22:00 milli maç
const NAT_MATCH_HOUR = 22;
// A Milli + U21: sezonda haftada 1 dostluk maçı (lig ~9 hafta / 18 maç)
const FIXTURE_GAP_DAYS = 7;

const NAT_INTERVAL_MS = process.env.NAT_INTERVAL_MS
  ? Number(process.env.NAT_INTERVAL_MS)
  : null; // test modu — HTML'deki Perşembe 21:00 slotunu es geçer

function nextThursday21(fromMs) { // isim tarihi; aslında NAT_MATCH_DAY/HOUR
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
  const c = String(country || "Türkiye").trim() || "Türkiye";
  if (typeof nationalRepo.ensureTeamRow === "function") {
    return nationalRepo.ensureTeamRow(c, cat);
  }
  let team = await nationalRepo.getTeamByCountry(c, cat);
  return team;
}

/** Sadece .env'deki ADMIN_USERNAME ile eşleşen hesap TD ataması yapabilir. */
function isAdmin(username) {
  const adminName = process.env.ADMIN_USERNAME;
  return !!adminName && !!username && username.toLowerCase() === adminName.toLowerCase();
}

async function getState(country, userId, clubId, username, category) {
  try {
    const { ensureNationalSchema } = require("./ensureNationalSchema");
    await ensureNationalSchema();
  } catch (_) {}
  const team = await ensureTeam(country, category);
  if (!team) return null;
  const cat = team.category || (String(category || "A").toUpperCase() === "U21" ? "U21" : "A");
  const maxAge = cat === "U21" ? 21 : null;
  // Tek sorgu patlasın diye hepsini birden düşürme — settled ile izole et
  const settled = await Promise.allSettled([
    nationalRepo.getSquad(team.id),
    nationalRepo.listCandidates(country, team.id, maxAge),
    nationalRepo.getUpcomingFixture(team.id),
    nationalRepo.listRecentFixtures(team.id, 5),
    nationalRepo.getMyApplication(team.id, userId),
  ]);
  const pick = (i, fallback) => {
    const s = settled[i];
    if (s.status === "fulfilled") return s.value;
    console.warn(
      "[national.getState] partial fail",
      i,
      s.reason && s.reason.message ? s.reason.message : s.reason,
    );
    return fallback;
  };
  const squad = pick(0, []);
  const candidatesRaw = pick(1, []);
  const nextFixture = pick(2, null);
  const recent = pick(3, []);
  const myApplication = pick(4, null);
  const candidates = (candidatesRaw || []).filter((c) => !c.called);

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
  // A + U21: koltuk dolu olsa bile herkes başvuru gönderebilir.
  // Atama sadece ADMIN_USERNAME (murat) tarafından yapılır.
  if (team.managerUserId && String(team.managerUserId) === String(userId)) {
    return { ok: false, error: "Zaten bu takımın teknik direktörüsün" };
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
  const pid = String(playerId || "");
  const found = candidates.find((c) => String(c.playerId) === pid);
  if (!found) return { ok: false, error: "Oyuncu aday havuzunda değil" };
  return nationalRepo.callUpPlayer(chk.team.id, found.playerId, found.clubId);
}

async function drop(country, userId, playerId, category) {
  const chk = await requireManager(country, userId, category);
  if (!chk.ok) return chk;
  return nationalRepo.dropPlayer(chk.team.id, String(playerId || ""));
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
  // 2) Kalan boş slotlar: GK slotuna yalnızca GK; diğer slotlara kalan en iyiler.
  // (Eski kod son çarede non-GK'yi GK'ye koyabiliyordu.)
  const leftovers = ranked.filter((p) => !used.has(p.playerId));
  slots.forEach((pos) => {
    if (finalAssignments.some((a) => a.pos === pos)) return;
    let pick = null;
    if (pos === "GK") {
      pick = leftovers.find(
        (p) =>
          !used.has(p.playerId) &&
          String(p.naturalPos || p.pos || "").toUpperCase() === "GK",
      );
    } else {
      pick = leftovers.find((p) => !used.has(p.playerId));
    }
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

// ============================================================
// Paylaşılan milli grup kuraları (tüm kullanıcılar aynı sonucu görür)
// game_settings key: national_group_draw_A / national_group_draw_U21
// ============================================================
const seasonConfig = require("./seasonConfig");
const countriesMod = require("./countries");

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * Ülke sıralama satırları (DB lig standings + sabit güç).
 * Tüm kullanıcılar aynı sonucu görür.
 */
async function buildCountryRankingRows(category) {
  const cat = String(category || "A").toUpperCase() === "U21" ? "U21" : "A";
  const names = countriesMod.SUPPORTED_COUNTRIES.slice();
  const leagueRepo = require("./repos/leagueRepo");

  const rows = [];
  for (const c of names) {
    let pts = 0;
    let strength = 55;
    let clubCount = 0;
    let topClub = null;
    try {
      const season = await leagueRepo.getCurrentSeason(c, 1);
      if (season) {
        const standings = await leagueRepo.getStandings(season.id);
        clubCount = standings.length;
        pts = standings.reduce((s, t) => s + (Number(t.pts) || 0), 0);
        if (standings.length) {
          const avgPts =
            standings.reduce((s, t) => s + (Number(t.pts) || 0), 0) /
            standings.length;
          strength = Math.max(40, Math.min(90, Math.round(50 + avgPts * 1.5)));
          topClub = standings[0]
            ? { name: standings[0].name, pts: standings[0].pts }
            : null;
        }
      }
    } catch (_) {}
    // Deterministik seed: ülke adından sabit offset (kullanıcıya göre değişmez)
    let seed = 0;
    for (let i = 0; i < c.length; i++) seed = (seed * 31 + c.charCodeAt(i)) % 17;
    strength = Math.max(42, Math.min(88, strength + seed - 8));

    const displayPts =
      cat === "U21"
        ? Math.round(pts * 0.55 + strength)
        : pts + strength;

    rows.push({
      c,
      pts: displayPts,
      strength,
      clubCount,
      topClub,
      category: cat,
    });
  }
  rows.sort((a, b) => b.pts - a.pts || a.c.localeCompare(b.c, "tr"));
  return rows;
}

/**
 * Milli eleme torba + grup kurası.
 * - 4 torba (serpme)
 * - Grup sayısı = ceil(n / 4), her grupta ~4 takım (64 ülke → 16 grup)
 * - n < 16 ise en az 4 grup (eksik torba toleranslı)
 */
function groupCountFor(n) {
  const teams = Math.max(0, Number(n) || 0);
  if (teams <= 0) return 4;
  // Her grup 4 takım; 4–16 grup arası tut
  const g = Math.ceil(teams / 4);
  return Math.max(4, Math.min(16, g));
}

function potsFromRows(rows) {
  const sorted = (rows || []).slice().sort((a, b) => b.pts - a.pts);
  const nGroups = groupCountFor(sorted.length);
  // 4 torba: her torbaya yaklaşık nGroups takım
  const pots = [[], [], [], []];
  sorted.forEach((r, i) => {
    const pot = Math.min(3, Math.floor(i / Math.max(1, nGroups)));
    pots[pot].push(Object.assign({}, r, { pot: pot + 1 }));
  });
  return pots;
}

function drawGroupsFromPots(rows) {
  const sorted = (rows || []).slice().sort((a, b) => b.pts - a.pts);
  const nGroups = groupCountFor(sorted.length);
  const pots = potsFromRows(sorted).map((p) => p.slice());
  pots.forEach((pot) => shuffleInPlace(pot));
  const groups = Array.from({ length: nGroups }, () => []);
  // Serpme: her torbadan sırayla gruplara
  for (let potIdx = 0; potIdx < 4; potIdx++) {
    for (let i = 0; i < pots[potIdx].length; i++) {
      const g = i % nGroups;
      groups[g].push(pots[potIdx][i]);
    }
  }
  return groups;
}

/**
 * Kayıtlı kura yoksa bir kez çeker ve game_settings'e yazar.
 * force=true yalnızca admin full-reset için.
 */
async function getOrCreateGroupDraw(category, force = false) {
  const cat = String(category || "A").toUpperCase() === "U21" ? "U21" : "A";
  const key = "national_group_draw_" + cat;
  const rows = await buildCountryRankingRows(cat);

  if (!force) {
    try {
      const raw = await seasonConfig.getSetting?.(key, null);
      // seasonConfig doesn't export getSetting — use query
    } catch (_) {}
  }

  const { query } = require("./db");
  if (!force) {
    try {
      const { rows: gs } = await query(
        `SELECT value FROM game_settings WHERE key = $1`,
        [key],
      );
      if (gs[0] && gs[0].value) {
        const saved = JSON.parse(gs[0].value);
        if (saved && saved.groups && saved.groups.length >= 4) {
          const byC = {};
          rows.forEach((r) => {
            byC[r.c] = r;
          });
          const groups = saved.groups.map((g) =>
            (g || []).map((name) => {
              const r = byC[name] || { c: name, pts: 0, strength: 50 };
              return Object.assign({}, r, {
                pot: (saved.pots && saved.pots[name]) || undefined,
              });
            }),
          );
          return {
            category: cat,
            pots: potsFromRows(rows),
            groups,
            ranking: rows,
            drawnAt: saved.drawnAt || null,
            auto: true,
          };
        }
      }
    } catch (e) {
      console.warn("[national] load draw", e.message);
    }
  }

  // Yeni kura
  const groups = drawGroupsFromPots(rows);
  const potsMap = {};
  groups.forEach((g) => {
    g.forEach((t) => {
      potsMap[t.c] = t.pot;
    });
  });
  const payload = {
    groups: groups.map((g) => g.map((t) => t.c)),
    pots: potsMap,
    drawnAt: new Date().toISOString(),
  };
  await query(
    `INSERT INTO game_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(payload)],
  );

  return {
    category: cat,
    pots: potsFromRows(rows),
    groups,
    ranking: rows,
    drawnAt: payload.drawnAt,
    auto: true,
  };
}

/**
 * Ülke profili — önemli bilgiler (paylaşılan, DB tabanlı)
 */
async function getCountryProfile(country, category) {
  const cat = String(category || "A").toUpperCase() === "U21" ? "U21" : "A";
  const c = String(country || "Türkiye").trim();
  const leagueRepo = require("./repos/leagueRepo");
  const nationalRepo = require("./repos/nationalRepo");

  let standings = [];
  let season = null;
  try {
    season = await leagueRepo.getCurrentSeason(c, 1);
    if (season) standings = await leagueRepo.getStandings(season.id);
  } catch (_) {}

  let natTeam = null;
  try {
    natTeam = await nationalRepo.getTeamByCountry(c, cat);
  } catch (_) {}

  let managerName = null;
  if (natTeam && natTeam.managerUserId) {
    try {
      const { query } = require("./db");
      const { rows } = await query(
        `SELECT u.username, cl.name AS club_name
         FROM users u
         LEFT JOIN clubs cl ON cl.user_id = u.id
         WHERE u.id = $1`,
        [natTeam.managerUserId],
      );
      if (rows[0]) {
        managerName = rows[0].username;
        natTeam.managerClubName = rows[0].club_name || natTeam.managerClubName;
      }
    } catch (_) {}
  }

  const ranking = await buildCountryRankingRows(cat);
  const rankIdx = ranking.findIndex((r) => r.c === c);
  const rankRow = rankIdx >= 0 ? ranking[rankIdx] : null;

  let recentFixtures = [];
  try {
    if (natTeam && natTeam.id) {
      recentFixtures = await nationalRepo.listRecentFixtures(natTeam.id, 8);
    }
  } catch (_) {}

  // Güncel milli kadro — son açıklanan / son maçta kullanılan ilk 11 + yedekler
  let squad = [];
  try {
    if (natTeam && natTeam.id) {
      const raw = await nationalRepo.getSquad(natTeam.id);
      squad = (raw || []).map((p) => ({
        playerId: p.playerId,
        name: p.name,
        pos: p.pos || p.naturalPos || "?",
        naturalPos: p.naturalPos || p.pos || "?",
        age: p.age,
        overall: p.overall,
        clubName: p.clubName || null,
        isStarter: !!p.isStarter,
      }));
    }
  } catch (_) {}

  const starters = squad.filter((p) => p.isStarter);
  const bench = squad.filter((p) => !p.isStarter);
  const lastFx = recentFixtures && recentFixtures[0] ? recentFixtures[0] : null;
  const lastMatch = lastFx
    ? {
        opponentName: lastFx.opponent_name || lastFx.opponentName || "?",
        homeGoals:
          lastFx.home_goals != null ? lastFx.home_goals : lastFx.homeGoals,
        awayGoals:
          lastFx.away_goals != null ? lastFx.away_goals : lastFx.awayGoals,
        kickoffAt: lastFx.kickoff_at || lastFx.kickoffAt || null,
        formation: natTeam ? natTeam.formation : "4-4-2",
        starters,
        bench,
      }
    : starters.length
      ? {
          opponentName: null,
          homeGoals: null,
          awayGoals: null,
          kickoffAt: null,
          formation: natTeam ? natTeam.formation : "4-4-2",
          starters,
          bench,
          note: "Henüz bitmiş milli maç yok — güncel açıklanan kadro",
        }
      : null;

  const humanClubs = standings.filter((s) => !s.isBot).length;
  const botClubs = standings.filter((s) => s.isBot).length;

  return {
    country: c,
    category: cat,
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    pts: rankRow ? rankRow.pts : 0,
    strength: rankRow ? rankRow.strength : 50,
    season: season
      ? { id: season.id, yearLabel: season.year_label, division: 1 }
      : null,
    standings: standings.slice(0, 12).map((s) => ({
      name: s.name,
      pts: s.pts,
      played: s.played,
      w: s.w,
      d: s.d,
      l: s.l,
      gf: s.gf,
      ga: s.ga,
      isBot: !!s.isBot,
    })),
    clubCount: standings.length,
    humanClubs,
    botClubs,
    manager: natTeam
      ? {
          username: managerName,
          clubName: natTeam.managerClubName || null,
          vacant: !natTeam.managerUserId,
          since: natTeam.managerSince || null,
        }
      : { vacant: true },
    formation: natTeam ? natTeam.formation : "4-4-2",
    recentFixtures: (recentFixtures || []).map((f) => ({
      opponentName: f.opponent_name || f.opponentName,
      homeGoals: f.home_goals != null ? f.home_goals : f.homeGoals,
      awayGoals: f.away_goals != null ? f.away_goals : f.awayGoals,
      kickoffAt: f.kickoff_at || f.kickoffAt,
      status: f.status,
    })),
    nationalArena: c + " National Arena",
    capacity: 40000 + ((c.length * 1234) % 30000),
    squad,
    lastMatch,
  };
}

module.exports.getOrCreateGroupDraw = getOrCreateGroupDraw;
module.exports.buildCountryRankingRows = buildCountryRankingRows;
module.exports.getCountryProfile = getCountryProfile;
