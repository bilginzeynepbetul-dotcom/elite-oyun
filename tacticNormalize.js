// ============================================================
// tacticNormalize.js — Taktik string normalizasyonu
// ============================================================

const PRESS_MAP = {
  dusuk: "düşük",
  düşük: "düşük",
  low: "düşük",
  orta: "orta",
  medium: "orta",
  high: "yüksek",
  yuksek: "yüksek",
  yüksek: "yüksek",
  extreme: "aşırı",
  asiri: "aşırı",
  aşırı: "aşırı",
};

const PASS_MAP = {
  kisa: "kısa",
  kısa: "kısa",
  short: "kısa",
  karisik: "karışık",
  karışık: "karışık",
  mixed: "karışık",
  uzun: "uzun",
  long: "uzun",
};

const ATTACK_MAP = {
  sol: "sol",
  left: "sol",
  orta: "orta",
  center: "orta",
  centre: "orta",
  sag: "sağ",
  sağ: "sağ",
  right: "sağ",
};

const STYLE_MAP = {
  dengeli: "dengeli",
  balanced: "dengeli",
  // Maç motoru (ballSystem.js, matchEngine.js) ve tüm istemci UI'ları
  // hücum stilini "hücumsel" string'iyle kontrol ediyor. Önceden bu harita
  // "ofansif" üretiyordu; hiçbir yerde "ofansif" kontrol edilmediği için
  // kullanıcı "Hücum" seçse bile fallback'e (dengeli) düşüyordu.
  hücumsel: "hücumsel",
  hucumsel: "hücumsel",
  ofansif: "hücumsel",
  attacking: "hücumsel",
  defansif: "defansif",
  defensive: "defansif",
  kontrol: "kontrol",
  counter: "kontra",
  kontra: "kontra",
};

function normalizePressIntensity(v, fallback = "orta") {
  if (v == null || v === "") return fallback;
  const key = String(v).toLowerCase().trim();
  return PRESS_MAP[key] || fallback;
}

function normalizePassStyle(v, fallback = "kısa") {
  if (v == null || v === "") return fallback;
  const key = String(v)
    .toLowerCase()
    .trim()
    .replace(/ı/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
  // raw with diacritics
  const raw = String(v).toLowerCase().trim();
  return PASS_MAP[raw] || PASS_MAP[key] || fallback;
}

function normalizeAttackDir(v, fallback = "orta") {
  if (v == null || v === "") return fallback;
  const key = String(v).toLowerCase().trim();
  return ATTACK_MAP[key] || fallback;
}

function normalizeTransitionStyle(v, fallback = "dengeli") {
  if (v == null || v === "") return fallback;
  const key = String(v).toLowerCase().trim();
  return STYLE_MAP[key] || fallback;
}

function normalizeGameStyle(v, fallback = "dengeli") {
  return normalizeTransitionStyle(v, fallback);
}

/**
 * Taktikleri team objesine uygular (matchEngine / client sync).
 */
function applyNormalizedTacticsToTeam(team, tactics) {
  if (!team) return team;
  const t = tactics || {};
  team.formation = t.formation || team.formation || "4-4-2";
  team.gameStyle = normalizeGameStyle(
    t.gameStyle || t.style || team.gameStyle,
    "dengeli",
  );
  team.passStyle = normalizePassStyle(
    t.passStyle || team.passStyle,
    "kısa",
  );
  team.attackDir = normalizeAttackDir(
    t.attackDir || team.attackDir,
    "orta",
  );
  team.pressIntensity = normalizePressIntensity(
    t.pressIntensity || t.press || team.pressIntensity,
    "orta",
  );
  team.transitionStyle = normalizeTransitionStyle(
    t.transitionStyle || team.transitionStyle,
    "dengeli",
  );
  if (t.customTactics && typeof t.customTactics === "object") {
    team.customTactics = Object.assign({}, team.customTactics || {}, t.customTactics);
  } else {
    team.customTactics = team.customTactics || {};
  }
  if (t.matchBonuses && typeof t.matchBonuses === "object") {
    team.matchBonuses = Object.assign(
      { attack: 0, midfield: 0, defense: 0, gk: 0 },
      team.matchBonuses || {},
      t.matchBonuses,
    );
  } else {
    team.matchBonuses = team.matchBonuses || {
      attack: 0,
      midfield: 0,
      defense: 0,
      gk: 0,
    };
  }
  return team;
}

module.exports = {
  normalizePressIntensity,
  normalizePassStyle,
  normalizeAttackDir,
  normalizeTransitionStyle,
  normalizeGameStyle,
  applyNormalizedTacticsToTeam,
};
