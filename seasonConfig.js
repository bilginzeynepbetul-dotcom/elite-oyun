// ============================================================
// seasonConfig.js — sezon başlangıcı + lig maç slotları
// 3 saat kuralı yok; scheduleMode = calendar_slots
// ============================================================

const { query } = require("./db");

const DEFAULT_START = "2026-08-10T15:00:00+03:00";

async function getSetting(key, fallback) {
  try {
    const { rows } = await query(
      `SELECT value FROM game_settings WHERE key = $1`,
      [key],
    );
    if (rows[0] && rows[0].value != null && rows[0].value !== "") {
      return rows[0].value;
    }
  } catch (_) {}
  return fallback;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO game_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)],
  );
}

async function getSeasonStartAt() {
  const raw =
    (await getSetting("season_start_at", null)) ||
    process.env.SEASON_START_AT ||
    DEFAULT_START;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return new Date(DEFAULT_START);
  return d;
}

async function getLeagueMatchSlots() {
  const raw = await getSetting("league_match_slots", null);
  try {
    const cal = require("./calendarSchedule");
    return cal.parseSlots(raw);
  } catch (_) {
    try {
      const cal = require("./calendarSchedule");
      return cal.DEFAULT_SLOTS.slice();
    } catch (__) {
      return [
        { dow: 6, hour: 15, minute: 0 },
        { dow: 6, hour: 18, minute: 0 },
        { dow: 0, hour: 15, minute: 0 },
        { dow: 0, hour: 18, minute: 0 },
      ];
    }
  }
}

async function setLeagueMatchSlots(slots) {
  await setSetting("league_match_slots", JSON.stringify(slots));
  return { ok: true, slots };
}

async function getConfig() {
  const startAt = await getSeasonStartAt();
  const slots = await getLeagueMatchSlots();
  return {
    seasonStartAt: startAt.toISOString(),
    seasonStartAtLocal: startAt.toLocaleString("tr-TR", {
      timeZone: "Europe/Istanbul",
    }),
    leagueMatchSlots: slots,
    scheduleMode: "calendar_slots",
    note: "3 saat kuralı yok — sadece slot gün/saatleri",
  };
}

async function setSeasonStartAt(isoOrDate) {
  let d;
  if (isoOrDate instanceof Date) d = isoOrDate;
  else {
    const s = String(isoOrDate).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      d = new Date(s + "T15:00:00+03:00");
    } else {
      d = new Date(s);
    }
  }
  if (Number.isNaN(d.getTime())) return { ok: false, error: "Geçersiz tarih" };
  await setSetting("season_start_at", d.toISOString());
  return { ok: true, seasonStartAt: d.toISOString() };
}

// Geriye dönük stub (artık kullanılmıyor)
async function getFixtureIntervalHours() {
  return 0;
}
async function setFixtureIntervalHours() {
  return { ok: true, intervalHours: 0, deprecated: true };
}

module.exports = {
  getSeasonStartAt,
  getFixtureIntervalHours,
  getLeagueMatchSlots,
  setLeagueMatchSlots,
  getConfig,
  setSeasonStartAt,
  setFixtureIntervalHours,
  DEFAULT_START,
};
