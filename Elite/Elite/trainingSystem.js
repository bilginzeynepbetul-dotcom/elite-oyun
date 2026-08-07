// ============================================================
// trainingSystem.js — SUNUCU TARAFLI ANTRENMAN + ANTRENÖR
// ------------------------------------------------------------
// configure({ getClub, adjustBalance, getTeam, saveTeam,
//             getTrainingState, saveTrainingState })
// ============================================================

const SKILL_LABELS = {
  reflex: "Refleks",
  handling: "Top Tutma",
  positioning: "Pozisyon",
  passing: "Pas",
  finishing: "Bitiricilik",
  tackle: "Müdahale",
  vision: "Görüş",
  pace: "Hız",
  dribbling: "Top Sürme",
  stamina: "Dayanıklılık",
  strength: "Güç",
  technique: "Teknik",
  agility: "Çeviklik",
};

const VALID_SKILLS = Object.keys(SKILL_LABELS);
const MAX_COACHES = 3;

/** clubId → { coaches: [], recent: [] } */
const store = new Map();

let deps = {
  getClub: null,
  adjustBalance: null,
  getTeam: null,
  saveTeam: null,
  getTrainingState: null,
  saveTrainingState: null,
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
    coaches: [
      {
        id: "coach_default_stamina",
        name: "Dayanıklılık Antrenörü",
        level: 1,
        salary: 8000,
        skill: "stamina",
        skillLabel: "Dayanıklılık",
      },
    ],
    recent: [],
  };
}

async function loadState(clubId) {
  if (store.has(clubId)) return store.get(clubId);
  let s = null;
  if (typeof deps.getTrainingState === "function") {
    try {
      s = await _call(deps.getTrainingState, clubId);
    } catch (e) {}
  }
  if (!s) s = defaultState();
  if (!Array.isArray(s.coaches)) s.coaches = defaultState().coaches;
  if (!Array.isArray(s.recent)) s.recent = [];
  store.set(clubId, s);
  return s;
}

async function persist(clubId, s) {
  store.set(clubId, s);
  if (typeof deps.saveTrainingState === "function") {
    try {
      await _call(deps.saveTrainingState, clubId, s);
    } catch (e) {}
  }
}

function coachTrainingFactor(coaches, skill) {
  const list = Array.isArray(coaches) ? coaches : [];
  if (!list.length) return 0.3;
  let best = list[0];
  if (skill) {
    const match = list.find((c) => c.skill === skill);
    if (match) best = match;
    else {
      best = list.slice().sort((a, b) => (b.level || 1) - (a.level || 1))[0];
      const lv = Math.max(1, Math.min(5, best.level || 1));
      return (0.35 + (lv - 1) * (0.65 / 4)) * 0.25;
    }
  }
  const lv = Math.max(1, Math.min(5, best.level || 1));
  return 0.35 + (lv - 1) * (0.65 / 4);
}

function estimatePotential(p) {
  if (p.basePotential != null) return Number(p.basePotential) || 5;
  const keys = [
    "pace",
    "passing",
    "finishing",
    "tackle",
    "vision",
    "stamina",
    "strength",
    "technique",
    "agility",
    "positioning",
  ];
  const avg =
    keys.reduce((s, k) => s + (Number(p[k]) || 10), 0) / keys.length;
  return Math.max(1, Math.min(10, Math.round(avg / 2)));
}

function applySkillGain(player, skill, coaches) {
  if (!player || !skill || VALID_SKILLS.indexOf(skill) < 0) {
    return { ok: false, error: "Geçersiz skill" };
  }
  const potential = estimatePotential(player);
  const age = player.age || 18;
  const ageFactor =
    age <= 20 ? 1.55 : age < 25 ? 1.2 : age < 28 ? 0.85 : 0.4;
  const potFactor = 0.4 + (potential / 10) * 0.9;
  const baseGain = 0.22 * (potential / 10);
  const cond = Number(player.condition) || 80;
  const condFactor = cond < 70 ? 0.45 : cond < 80 ? 0.75 : 1;
  let gain =
    baseGain *
    ageFactor *
    coachTrainingFactor(coaches, skill) *
    condFactor *
    (0.9 + Math.random() * 0.2);

  if (player[skill] == null) player[skill] = 8 + Math.random() * 3;
  const cur = Number(player[skill]) || 10;
  const next = Math.min(20, cur + gain);
  const delta = next - cur;
  player[skill] = next;
  player.experience = (Number(player.experience) || 0) + 0.12 * potFactor;

  let condGain = 1 + Math.random() * 2;
  if (skill === "stamina") condGain = 6 + Math.random() * 6;
  player.condition = Math.min(100, (Number(player.condition) || 80) + condGain);

  return {
    ok: true,
    playerId: player.id,
    name: player.name,
    skill,
    skillLabel: SKILL_LABELS[skill] || skill,
    from: Math.round(cur * 100) / 100,
    to: Math.round(next * 100) / 100,
    delta: Math.round(delta * 100) / 100,
    condition: Math.round(player.condition),
  };
}

function findPlayerInTeam(team, playerId) {
  const pid = String(playerId);
  for (const list of [team.players || [], team.bench || []]) {
    const idx = list.findIndex((p) => p && String(p.id) === pid);
    if (idx >= 0) return { list, idx, player: list[idx] };
  }
  return null;
}

async function trainPlayer(clubId, playerId, skill) {
  if (typeof deps.getTeam !== "function" || typeof deps.saveTeam !== "function") {
    return { ok: false, error: "Takım depolama yapılandırılmadı" };
  }
  const team = await _call(deps.getTeam, clubId);
  if (!team) return { ok: false, error: "Takım yok" };
  const found = findPlayerInTeam(team, playerId);
  if (!found) return { ok: false, error: "Oyuncu kadroda değil" };

  const s = await loadState(clubId);
  const result = applySkillGain(found.player, skill, s.coaches);
  if (!result.ok) return result;

  found.list[found.idx] = found.player;
  await _call(deps.saveTeam, clubId, team);

  s.recent.unshift({
    name: result.name,
    skill: result.skill,
    skillLabel: result.skillLabel,
    delta: result.delta,
    to: result.to,
    at: Date.now(),
  });
  if (s.recent.length > 40) s.recent.length = 40;
  await persist(clubId, s);

  deps.log && deps.log("[train]", clubId, result.name, skill, "+" + result.delta);
  return { ok: true, result, recent: s.recent.slice(0, 15) };
}

async function trainSquad(clubId, skill) {
  if (typeof deps.getTeam !== "function" || typeof deps.saveTeam !== "function") {
    return { ok: false, error: "Takım depolama yapılandırılmadı" };
  }
  const team = await _call(deps.getTeam, clubId);
  if (!team) return { ok: false, error: "Takım yok" };
  const s = await loadState(clubId);
  const all = [...(team.players || []), ...(team.bench || [])];
  const results = [];
  all.forEach((p) => {
    if (!p) return;
    const r = applySkillGain(p, skill, s.coaches);
    if (r.ok) {
      results.push(r);
      s.recent.unshift({
        name: r.name,
        skill: r.skill,
        skillLabel: r.skillLabel,
        delta: r.delta,
        to: r.to,
        at: Date.now(),
      });
    }
  });
  if (s.recent.length > 40) s.recent.length = 40;
  await _call(deps.saveTeam, clubId, team);
  await persist(clubId, s);
  return {
    ok: true,
    count: results.length,
    skill,
    skillLabel: SKILL_LABELS[skill] || skill,
    results: results.slice(0, 20),
    recent: s.recent.slice(0, 15),
  };
}

function coachSalary(level) {
  return Math.round(5000 + level * 6000 + level * level * 1500);
}

async function hireCoach(clubId, skill, level) {
  level = Math.max(1, Math.min(5, Math.floor(Number(level) || 1)));
  if (VALID_SKILLS.indexOf(skill) < 0)
    return { ok: false, error: "Geçersiz skill" };

  const s = await loadState(clubId);
  const existing = s.coaches.findIndex((c) => c.skill === skill);
  const salary = coachSalary(level);
  const coach = {
    id: "coach_" + skill + "_" + level,
    name: (SKILL_LABELS[skill] || skill) + " Antrenörü",
    level,
    salary,
    skill,
    skillLabel: SKILL_LABELS[skill] || skill,
  };

  if (existing >= 0) {
    s.coaches[existing] = coach;
  } else {
    if (s.coaches.length >= MAX_COACHES) {
      return {
        ok: false,
        error: "En fazla " + MAX_COACHES + " antrenör. Önce birini çıkar.",
      };
    }
    s.coaches.push(coach);
  }
  await persist(clubId, s);
  return { ok: true, coaches: s.coaches };
}

async function removeCoach(clubId, skill) {
  const s = await loadState(clubId);
  s.coaches = s.coaches.filter((c) => c.skill !== skill);
  if (!s.coaches.length) {
    s.coaches = defaultState().coaches;
  }
  await persist(clubId, s);
  return { ok: true, coaches: s.coaches };
}

async function getState(clubId) {
  const s = await loadState(clubId);
  let conditionSummary = null;
  if (typeof deps.getTeam === "function") {
    const team = await _call(deps.getTeam, clubId);
    if (team) {
      const all = [...(team.players || []), ...(team.bench || [])];
      const avg = all.length
        ? Math.round(
            all.reduce((a, p) => a + (Number(p.condition) || 90), 0) /
              all.length,
          )
        : 0;
      const low = all.filter((p) => (Number(p.condition) || 90) < 70).length;
      conditionSummary = { avg, low, count: all.length };
    }
  }
  return {
    coaches: s.coaches,
    recent: s.recent.slice(0, 15),
    conditionSummary,
    skills: SKILL_LABELS,
  };
}

module.exports = {
  configure,
  getState,
  trainPlayer,
  trainSquad,
  hireCoach,
  removeCoach,
  SKILL_LABELS,
  VALID_SKILLS,
};
