// ============================================================
// seasonConfig.js — game_settings key/value
// ============================================================

const { query } = require("./db");

async function getSetting(key, defaultValue = null) {
  try {
    const { rows } = await query(
      `SELECT value FROM game_settings WHERE key = $1`,
      [String(key)],
    );
    if (!rows[0]) return defaultValue;
    return rows[0].value;
  } catch (_) {
    return defaultValue;
  }
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO game_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(key), value == null ? "" : String(value)],
  );
  return true;
}

async function getJson(key, fallback) {
  const raw = await getSetting(key, null);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function setJson(key, obj) {
  return setSetting(key, JSON.stringify(obj));
}

module.exports = { getSetting, setSetting, getJson, setJson };
