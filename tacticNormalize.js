// ============================================================
// tacticNormalize.js — Pas / oyun stili / hücum yönü / özel taktik
// Tek merkez: Türkçe karakter varyasyonları + whitelist
// ============================================================

const PASS_STYLES = ["kisa", "uzun", "hizli", "karisik"];
const GAME_STYLES = ["dengeli", "hucumsel", "defansif"];
const ATTACK_DIRS = ["orta", "kanatlardan", "sol", "sag"];

/** ASCII-ish normalize: İ/ı → i, ğ→g, ü→u, ş→s, ö→o, ç→c */
function foldTr(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/\s+/g, "");
}

const PASS_ALIASES = {
  kisa: "kisa",
  kisa: "kisa",
  short: "kisa",
  uzun: "uzun",
  long: "uzun",
  hizli: "hizli",
  fast: "hizli",
  karisik: "karisik",
  mixed: "karisik",
  mix: "karisik",
};

// foldTr already maps kısa→kisa etc.
PASS_ALIASES[foldTr("kısa")] = "kisa";
PASS_ALIASES[foldTr("uzun")] = "uzun";
PASS_ALIASES[foldTr("hızlı")] = "hizli";
PASS_ALIASES[foldTr("karışık")] = "karisik";

const GAME_ALIASES = {
  dengeli: "dengeli",
  balanced: "dengeli",
  normal: "dengeli",
  hucumsel: "hucumsel",
  attacking: "hucumsel",
  attack: "hucumsel",
  defansif: "defansif",
  defensive: "defansif",
  defend: "defansif",
};
GAME_ALIASES[foldTr("hücumsel")] = "hucumsel";
GAME_ALIASES[foldTr("defansif")] = "defansif";
GAME_ALIASES[foldTr("dengeli")] = "dengeli";

const ATTACK_ALIASES = {
  orta: "orta",
  center: "orta",
  centre: "orta",
  kanatlardan: "kanatlardan",
  wings: "kanatlardan",
  wing: "kanatlardan",
  sol: "sol",
  left: "sol",
  sag: "sag",
  right: "sag",
};
ATTACK_ALIASES[foldTr("orta")] = "orta";
ATTACK_ALIASES[foldTr("kanatlardan")] = "kanatlardan";
ATTACK_ALIASES[foldTr("sol")] = "sol";
ATTACK_ALIASES[foldTr("sağ")] = "sag";

/** Canonical passStyle: kisa | uzun | hizli | karisik */
function normalizePassStyle(v, fallback) {
  const key = foldTr(v);
  const out = PASS_ALIASES[key] || PASS_ALIASES[foldTr(key)];
  if (out && PASS_STYLES.includes(out)) return out;
  const fb = foldTr(fallback || "kisa");
  return PASS_ALIASES[fb] || "kisa";
}

/**
 * Canonical gameStyle stored as Turkish display forms used in engines:
 * dengeli | hücumsel | defansif
 * (engines compare with "hücumsel" / "defansif")
 */
function normalizeGameStyle(v, fallback) {
  const key = foldTr(v);
  const canon = GAME_ALIASES[key];
  if (canon === "hucumsel") return "hücumsel";
  if (canon === "defansif") return "defansif";
  if (canon === "dengeli") return "dengeli";
  const fb = foldTr(fallback || "dengeli");
  if (GAME_ALIASES[fb] === "hucumsel") return "hücumsel";
  if (GAME_ALIASES[fb] === "defansif") return "defansif";
  return "dengeli";
}

/** Canonical attackDir: orta | kanatlardan | sol | sag */
function normalizeAttackDir(v, fallback) {
  const key = foldTr(v);
  const out = ATTACK_ALIASES[key];
  if (out && ATTACK_DIRS.includes(out)) return out;
  const fb = foldTr(fallback || "orta");
  return ATTACK_ALIASES[fb] || "orta";
}

const CUSTOM_TACTIC_KEYS = [
  "ritmicPassing",
  "agileFlanks",
  "dynamicWall",
  "chokePress",
  "clinicalFinishing",
  "sweeperKeeper",
  "deepPlaymaker",
  "gegenPress",
];

/** Özel taktik map: sadece bilinen anahtarlar, değer aktif|pasif */
function normalizeCustomTactics(raw) {
  const out = {};
  CUSTOM_TACTIC_KEYS.forEach((k) => {
    out[k] = "pasif";
  });
  if (!raw || typeof raw !== "object") return out;
  CUSTOM_TACTIC_KEYS.forEach((k) => {
    const v = raw[k];
    if (v === true || v === 1 || v === "aktif" || v === "active" || v === "on") {
      out[k] = "aktif";
    } else {
      out[k] = "pasif";
    }
  });
  return out;
}

/**
 * Tek giriş: takım taktik alanlarını normalize et (mutate veya kopya).
 * @returns {{ passStyle, gameStyle, attackDir, customTactics }}
 */

const PRESS_INTENSITIES = ["yuksek", "orta", "dusuk"];
const TRANSITION_STYLES = ["normal", "kontra"];

const PRESS_ALIASES = {
  yuksek: "yuksek",
  high: "yuksek",
  highpress: "yuksek",
  high_press: "yuksek",
  orta: "orta",
  medium: "orta",
  mid: "orta",
  dusuk: "dusuk",
  low: "dusuk",
  lowblock: "dusuk",
  low_block: "dusuk",
  blok: "dusuk",
};
PRESS_ALIASES[foldTr("yüksek")] = "yuksek";
PRESS_ALIASES[foldTr("yuksek")] = "yuksek";
PRESS_ALIASES[foldTr("orta")] = "orta";
PRESS_ALIASES[foldTr("düşük")] = "dusuk";
PRESS_ALIASES[foldTr("dusuk")] = "dusuk";

const TRANSITION_ALIASES = {
  normal: "normal",
  dengeli: "normal",
  kontra: "kontra",
  counter: "kontra",
  counterattack: "kontra",
  kontraatak: "kontra",
};
TRANSITION_ALIASES[foldTr("kontra")] = "kontra";
TRANSITION_ALIASES[foldTr("kontra atak")] = "kontra";

function normalizePressIntensity(v, fallback) {
  const key = foldTr(v);
  const out = PRESS_ALIASES[key];
  if (out && PRESS_INTENSITIES.includes(out)) return out;
  const fb = foldTr(fallback || "orta");
  return PRESS_ALIASES[fb] || "orta";
}

function normalizeTransitionStyle(v, fallback) {
  const key = foldTr(v);
  const out = TRANSITION_ALIASES[key];
  if (out && TRANSITION_STYLES.includes(out)) return out;
  const fb = foldTr(fallback || "normal");
  return TRANSITION_ALIASES[fb] || "normal";
}

function normalizeTactic(input, opts) {
  opts = opts || {};
  const src = input && typeof input === "object" ? input : {};
  const passStyle = normalizePassStyle(
    src.passStyle,
    opts.defaultPass || "kisa",
  );
  const gameStyle = normalizeGameStyle(
    src.gameStyle,
    opts.defaultGame || "dengeli",
  );
  const attackDir = normalizeAttackDir(
    src.attackDir,
    opts.defaultAttack || "orta",
  );
  const pressIntensity = normalizePressIntensity(
    src.pressIntensity,
    opts.defaultPress || "orta",
  );
  const transitionStyle = normalizeTransitionStyle(
    src.transitionStyle,
    opts.defaultTransition || "normal",
  );
  const customTactics = normalizeCustomTactics(
    src.customTactics || src.tactics || null,
  );
  return {
    passStyle,
    gameStyle,
    attackDir,
    pressIntensity,
    transitionStyle,
    customTactics,
  };
}

/** apply onto team object in place */
function applyNormalizedTacticsToTeam(team, partial) {
  if (!team || typeof team !== "object") return team;
  const n = normalizeTactic({
    passStyle: partial && partial.passStyle != null ? partial.passStyle : team.passStyle,
    gameStyle: partial && partial.gameStyle != null ? partial.gameStyle : team.gameStyle,
    attackDir: partial && partial.attackDir != null ? partial.attackDir : team.attackDir,
    pressIntensity:
      partial && partial.pressIntensity != null
        ? partial.pressIntensity
        : team.pressIntensity,
    transitionStyle:
      partial && partial.transitionStyle != null
        ? partial.transitionStyle
        : team.transitionStyle,
    customTactics:
      partial && partial.customTactics != null
        ? partial.customTactics
        : team.customTactics,
  });
  team.passStyle = n.passStyle;
  team.gameStyle = n.gameStyle;
  team.attackDir = n.attackDir;
  team.pressIntensity = n.pressIntensity;
  team.transitionStyle = n.transitionStyle;
  team.customTactics = n.customTactics;
  return team;
}

module.exports = {
  foldTr,
  PASS_STYLES,
  GAME_STYLES,
  ATTACK_DIRS,
  PRESS_INTENSITIES,
  TRANSITION_STYLES,
  CUSTOM_TACTIC_KEYS,
  normalizePassStyle,
  normalizeGameStyle,
  normalizeAttackDir,
  normalizePressIntensity,
  normalizeTransitionStyle,
  normalizeCustomTactics,
  normalizeTactic,
  applyNormalizedTacticsToTeam,
};
