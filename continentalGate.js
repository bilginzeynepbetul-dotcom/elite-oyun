// ============================================================
// continentalGate.js — Kıtasal Lig + Elite Kupa sezon kilidi
// ------------------------------------------------------------
// Bu sezon (ilk sezon) başlamaz.
// En az MIN_CLOSED ülke 1. Lig sezonunu kapatmış olmalı.
// ============================================================

const { query } = require("./db");

const MIN_CLOSED_COUNTRIES = Number(process.env.CL_MIN_CLOSED_COUNTRIES) || 8;

/**
 * Kıtasal Lig ve Elite Kupa 2. sezon için:
 * division=1 ve is_current=FALSE en az MIN_CLOSED ülke.
 */
async function canStartContinentalCompetitions() {
  try {
    const { rows } = await query(
      `SELECT COUNT(DISTINCT country)::int AS c
       FROM seasons
       WHERE division = 1 AND is_current = FALSE`,
    );
    const closed = (rows[0] && rows[0].c) || 0;
    if (closed < MIN_CLOSED_COUNTRIES) {
      return {
        ok: false,
        closed,
        need: MIN_CLOSED_COUNTRIES,
        reason: "season1_not_finished",
        hint:
          "Kıtasal Lig ve Elite Kupa 1. sezon bitince açılır (en az " +
          MIN_CLOSED_COUNTRIES +
          " ülkede 1. Lig kapanmış olmalı). Şu an: " +
          closed,
      };
    }
    return { ok: true, closed, need: MIN_CLOSED_COUNTRIES };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      hint: e.message || "Sezon kontrolü başarısız",
    };
  }
}

/**
 * Sezon kapanışından sonra her iki kupayı da dene (yoksa oluştur).
 * seasonLifecycle ve bootstrap burayı çağırır.
 */
async function tryStartSeason2Competitions(opts = {}) {
  const can = await canStartContinentalCompetitions();
  if (!can.ok) {
    return { started: false, ...can };
  }

  // Ortak slot: Çarşamba 15:00 TR (Kıtasal Lig + Elite Kupa)
  let startAt = opts.startAt;
  if (!startAt) {
    try {
      const cal = require("./calendarSchedule");
      startAt = cal.nextWednesday1500TR();
    } catch (_) {
      startAt = new Date();
      startAt.setUTCHours(12, 0, 0, 0);
      while (startAt.getUTCDay() !== 3) {
        startAt = new Date(startAt.getTime() + 86400000);
      }
      if (startAt.getTime() <= Date.now()) {
        startAt = new Date(startAt.getTime() + 7 * 86400000);
      }
    }
  }

  const yearLabel =
    opts.yearLabel || "S2-" + new Date().getFullYear();
  const out = { started: true, continental: null, eliteCup: null };

  // Kıtasal Lig (1.'ler)
  try {
    const continentalRepo = require("./repos/continentalRepo");
    const cur = await continentalRepo.getCurrentEdition();
    if (cur) {
      out.continental = { status: "exists", id: cur.id };
    } else {
      const r = await continentalRepo.createEdition(yearLabel, { startAt });
      out.continental = r;
    }
  } catch (e) {
    out.continental = { ok: false, error: e.message };
    console.warn("[continentalGate] kıtasal", e.message);
  }

  // Elite Kupa (2. + 3.'ler)
  try {
    const eliteCupRepo = require("./repos/eliteCupRepo");
    const cur = await eliteCupRepo.getCurrentEdition();
    if (cur) {
      out.eliteCup = { status: "exists", id: cur.id };
    } else {
      const r = await eliteCupRepo.createEdition("EK-" + yearLabel, {
        startAt,
      });
      out.eliteCup = r;
    }
  } catch (e) {
    out.eliteCup = { ok: false, error: e.message };
    console.warn("[continentalGate] elite", e.message);
  }

  return out;
}

module.exports = {
  MIN_CLOSED_COUNTRIES,
  canStartContinentalCompetitions,
  tryStartSeason2Competitions,
};
