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

/**
 * Bu gece sezon başlangıcı (Europe/Istanbul).
 * Varsayılan: bugün 21:00 TR. Geçildiyse 45 dk sonra.
 * Env: SEASON_START_AT (ISO) veya SEASON_START_HOUR_TR (0-23, varsayılan 21)
 */
function tonightSeasonStart(now = new Date()) {
  const hourTr = Number(process.env.SEASON_START_HOUR_TR);
  const h = Number.isFinite(hourTr) && hourTr >= 0 && hourTr <= 23 ? hourTr : 21;
  // TR = UTC+3 sabit
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  // 21:00 TR = 18:00 UTC
  let start = new Date(Date.UTC(y, m, d, h - 3, 0, 0, 0));
  if (start.getTime() <= now.getTime() + 5 * 60 * 1000) {
    // Bugün geçtiyse yarın aynı saat (veya 45 dk sonra acil)
    const soon = new Date(now.getTime() + 45 * 60 * 1000);
    const tomorrow = new Date(Date.UTC(y, m, d + 1, h - 3, 0, 0, 0));
    // Kullanıcı "bu gece" dedi — mümkünse bugün/hemen
    start = soon.getTime() < tomorrow.getTime() ? soon : tomorrow;
  }
  return start;
}

async function getSeasonStartAt() {
  const envIso = process.env.SEASON_START_AT;
  if (envIso && String(envIso).trim()) {
    const d = new Date(String(envIso).trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  try {
    const raw = await getSetting("season_start_at", null);
    if (raw) {
      const d = new Date(String(raw));
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch (_) {}
  return tonightSeasonStart();
}

async function setSeasonStartAt(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return false;
  await setSetting("season_start_at", d.toISOString());
  return true;
}

/** Boot: season_start_at yoksa veya geçmişse bu geceye çek */
async function ensureSeasonStartsTonight() {
  const tonight = tonightSeasonStart();
  try {
    const raw = await getSetting("season_start_at", null);
    if (!raw) {
      await setSeasonStartAt(tonight);
      return tonight;
    }
    const existing = new Date(String(raw));
    // Çok geçmiş (>1 gün) veya yok → bu gece
    if (Number.isNaN(existing.getTime()) || existing.getTime() < Date.now() - 24 * 3600 * 1000) {
      await setSeasonStartAt(tonight);
      return tonight;
    }
    // Gelecek ama uzak (>3 gün) → bu geceye çek (canlı açılış)
    if (existing.getTime() > Date.now() + 3 * 24 * 3600 * 1000) {
      await setSeasonStartAt(tonight);
      return tonight;
    }
    return existing;
  } catch (_) {
    return tonight;
  }
}

/** Lig maç slotları (game_settings veya takvim varsayılanı) */
async function getLeagueMatchSlots() {
  try {
    const raw = await getJson("league_match_slots", null);
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (_) {}
  try {
    const cal = require("./calendarSchedule");
    if (cal.DEFAULT_SLOTS) return cal.DEFAULT_SLOTS;
    if (typeof cal.slotsForCountry === "function") {
      return cal.slotsForCountry("Türkiye");
    }
  } catch (_) {}
  // Cmt/Paz 15:00 ve 18:00 TR benzeri
  return [
    { dow: 6, hour: 15, minute: 0 },
    { dow: 6, hour: 18, minute: 0 },
    { dow: 0, hour: 15, minute: 0 },
    { dow: 0, hour: 18, minute: 0 },
  ];
}

module.exports = {
  getSetting,
  setSetting,
  getJson,
  setJson,
  getSeasonStartAt,
  setSeasonStartAt,
  tonightSeasonStart,
  ensureSeasonStartsTonight,
  getLeagueMatchSlots,
};
