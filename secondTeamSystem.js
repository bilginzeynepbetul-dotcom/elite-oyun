// ============================================================
// secondTeamSystem.js — Elite B takımı (P1 #7)
// ============================================================

const clubsRepo = require("./repos/clubsRepo");
const premiumSystem = require("./premiumSystem");
const { createMockSquad } = require("./mockTeam");

const START_BUDGET = 1_500_000;

function lowerSkills(squad, factor = 0.88) {
  const scale = (p) => {
    if (!p) return p;
    const keys = [
      "pace", "passing", "finishing", "tackle", "vision",
      "stamina", "strength", "technique", "agility", "positioning",
      "reflex", "handling",
    ];
    const out = { ...p };
    for (const k of keys) {
      if (out[k] != null) {
        out[k] = Math.max(4, Math.round(Number(out[k]) * factor * 10) / 10);
      }
    }
    out.id = out.id || "b_" + Math.random().toString(36).slice(2, 10);
    return out;
  };
  return {
    name: squad.name,
    players: (squad.players || []).map(scale),
    bench: (squad.bench || []).map(scale),
  };
}

function normalize(data, club) {
  const d = data && typeof data === "object" ? data : {};
  let budget = Number(d.budget);
  if (!Number.isFinite(budget) || budget < 0) budget = START_BUDGET;
  // Anti-cheat: istemci bütçeyi artıramaz
  if (d._prevBudget != null && budget > Number(d._prevBudget) + 1) {
    budget = Number(d._prevBudget);
  }
  budget = Math.min(budget, START_BUDGET + 5_000_000);

  const name =
    String(d.name || (club && club.name ? club.name + " B" : "B Takımı"))
      .trim()
      .slice(0, 48) || "B Takımı";

  let players = Array.isArray(d.players) ? d.players.slice(0, 18) : [];
  let bench = Array.isArray(d.bench) ? d.bench.slice(0, 10) : [];
  if (players.length < 11) {
    const mock = lowerSkills(createMockSquad(name));
    while (players.length < 11 && mock.players.length) {
      players.push(mock.players.shift());
    }
    if (!bench.length) bench = mock.bench || [];
  }

  return {
    name,
    budget,
    country: (club && club.country) || "Türkiye",
    division: 2,
    players,
    bench,
    formation: d.formation || "4-4-2",
    updatedAt: Date.now(),
  };
}

async function requireElite(userId) {
  try {
    const st = await premiumSystem.getStatus(userId);
    return st && st.active;
  } catch (_) {
    return false;
  }
}

async function getSecondTeam(userId, clubId) {
  const elite = await requireElite(userId);
  const raw = await clubsRepo.getSecondTeam(clubId);
  return {
    ok: true,
    elite,
    secondTeam: raw || null,
    hasTeam: !!raw,
  };
}

async function ensureSecondTeam(userId, clubId, opts = {}) {
  const elite = await requireElite(userId);
  if (!elite) return { ok: false, error: "Elite üyelik gerekli" };

  let raw = await clubsRepo.getSecondTeam(clubId);
  if (raw && raw.players && raw.players.length >= 11) {
    return { ok: true, secondTeam: raw, created: false };
  }

  const club = await clubsRepo.getClub(clubId);
  const mock = lowerSkills(
    createMockSquad(opts.name || (club && club.name ? club.name + " B" : "B Takımı")),
  );
  const data = normalize(
    {
      name: opts.name || mock.name,
      budget: START_BUDGET,
      players: mock.players,
      bench: mock.bench,
    },
    club,
  );
  await clubsRepo.saveSecondTeam(clubId, data);

  // B takımı için 2. lig bot + fikstür (best-effort)
  try {
    const botClubs = require("./botClubs");
    const ctry = data.country || (club && club.country) || "Türkiye";
    setImmediate(() => {
      botClubs
        .ensureLeagueFilled({
          country: ctry,
          division: 2,
          targetSize: 8,
          generateFixtures: true,
        })
        .catch((e) =>
          console.warn("[secondTeam] fill div2", e.message),
        );
    });
  } catch (_) {}

  return { ok: true, secondTeam: data, created: true };
}

async function renameSecondTeam(userId, clubId, name) {
  const elite = await requireElite(userId);
  if (!elite) return { ok: false, error: "Elite üyelik gerekli" };
  const raw = (await clubsRepo.getSecondTeam(clubId)) || {};
  raw.name = String(name || "").trim().slice(0, 48) || raw.name || "B Takımı";
  await clubsRepo.saveSecondTeam(clubId, raw);
  return { ok: true, secondTeam: raw };
}

async function saveSecondTeam(userId, clubId, data) {
  const elite = await requireElite(userId);
  if (!elite) return { ok: false, error: "Elite üyelik gerekli" };
  const club = await clubsRepo.getClub(clubId);
  const prev = await clubsRepo.getSecondTeam(clubId);
  const incoming = data || {};
  if (prev) incoming._prevBudget = prev.budget;
  const normalized = normalize(incoming, club);
  await clubsRepo.saveSecondTeam(clubId, normalized);
  return { ok: true, secondTeam: normalized };
}

module.exports = {
  getSecondTeam,
  ensureSecondTeam,
  renameSecondTeam,
  saveSecondTeam,
  normalize,
  START_BUDGET,
};
