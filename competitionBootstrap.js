// ============================================================
// competitionBootstrap.js — Canlı sezon: kupa / kıtasal / milli / dostluk
// ------------------------------------------------------------
// Boot ve periyodik tick ile:
//  - Her ülke kupası (yoksa oluştur)
//  - Kıtasal turnuva (yoksa oluştur)
//  - Milli maç fikstürleri
//  - Haftalık dostluk (kupadan elenen + sezon başı)
// ============================================================

const { query } = require("./db");
const { SUPPORTED_COUNTRIES } = require("./countries");
const cupRepo = require("./repos/cupRepo");
const continentalRepo = require("./repos/continentalRepo");
const nationalSystem = require("./nationalSystem");
const friendlySystem = require("./friendlySystem");

function currentYearLabel(d = new Date()) {
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-11; Temmuz+ yeni sezon etiketi
  if (m >= 6) {
    return y + "/" + String((y + 1) % 100).padStart(2, "0");
  }
  return y - 1 + "/" + String(y % 100).padStart(2, "0");
}

/**
 * Tüm ülkeler için kupa edisyonu + ilk tur fikstürleri.
 * Zaten varsa dokunmaz (ensureEditionExists).
 */
async function ensureAllCups() {
  const results = [];
  for (const country of SUPPORTED_COUNTRIES) {
    try {
      const existing = await cupRepo.getCurrentEdition(country);
      if (existing) {
        results.push({ country, status: "exists", id: existing.id });
        continue;
      }
      const clubIds = await cupRepo.listClubIdsForCountry(country);
      if (!clubIds || clubIds.length < 2) {
        results.push({ country, status: "skip", reason: "yetersiz kulüp" });
        continue;
      }
      const yearLabel = currentYearLabel();
      let startAt = new Date(Date.now() + 45 * 60 * 1000);
      try {
        const seasonConfig = require("./seasonConfig");
        startAt = await seasonConfig.getSeasonStartAt();
      } catch (_) {}
      const r = await cupRepo.createEdition(country, yearLabel, clubIds, {
        startAt,
      });
      results.push({
        country,
        status: r && r.ok ? "created" : "error",
        detail: r,
      });
    } catch (e) {
      results.push({ country, status: "error", error: e.message });
      console.warn("[compBoot] cup", country, e.message);
    }
  }
  return results;
}

/**
 * Kıtasal Lig + Elite Kupa — yalnızca 1. sezon bitince (2. sezon).
 * Boot'ta zorla açılmaz.
 */
async function ensureContinental() {
  try {
    const gate = require("./continentalGate");
    const can = await gate.canStartContinentalCompetitions();
    if (!can.ok) {
      return {
        status: "skipped",
        reason: can.reason,
        hint: can.hint,
        closed: can.closed,
      };
    }
    return await gate.tryStartSeason2Competitions({
      yearLabel: currentYearLabel(),
    });
  } catch (e) {
    console.warn("[compBoot] continental", e.message);
    return { status: "error", error: e.message };
  }
}

/** Tüm ülkeler milli fikstür */
async function ensureAllNational() {
  const out = [];
  for (const country of SUPPORTED_COUNTRIES) {
    try {
      await nationalSystem.ensureAllNationalFixtures(country);
      out.push({ country, status: "ok" });
    } catch (e) {
      out.push({ country, status: "error", error: e.message });
      console.warn("[compBoot] national", country, e.message);
    }
  }
  return out;
}

/**
 * Haftalık otomatik dostluk:
 * - Lig kupası ile AYNI gün/saat: Perşembe 13:00 TR
 * - Sezon içi: kupadan elenen takımlar, lig fark etmeksizin (aynı ülke)
 * - Sezon öncesi (ilk lig maçından önce, ~2 hafta): herkes, haftada 2 maç
 *   (Perşembe 13:00 TR + Pazar 13:00 TR)
 */
async function scheduleWeeklyFriendlies(opts = {}) {
  const maxPairsPerCountry = opts.maxPairsPerCountry || 40;
  let cal = null;
  try {
    cal = require("./calendarSchedule");
  } catch (_) {}

  // Ana slot: Perşembe 13:00 TR (Lig Kupası ile aynı)
  let kickoffBase = opts.kickoffBase;
  if (!kickoffBase) {
    if (cal && typeof cal.nextThursday1300TR === "function") {
      kickoffBase = cal.nextThursday1300TR();
    } else {
      kickoffBase = new Date();
      kickoffBase.setUTCHours(10, 0, 0, 0);
      while (kickoffBase.getUTCDay() !== 4) {
        kickoffBase = new Date(kickoffBase.getTime() + 86400000);
      }
      if (kickoffBase.getTime() <= Date.now()) {
        kickoffBase = new Date(kickoffBase.getTime() + 7 * 86400000);
      }
    }
  }

  let scheduled = 0;
  let skipped = 0;
  let preSeasonCountries = 0;

  for (const country of SUPPORTED_COUNTRIES) {
    try {
      const pre = await friendlySystem.isPreSeasonWindow(country);
      const isPre = !!(pre && pre.preSeason);
      if (isPre) preSeasonCountries++;
      const maxPerWeek = isPre ? 2 : 1;

      // Aynı ülke, tüm ligler
      const { rows: clubs } = await query(
        `SELECT id, name, division, COALESCE(is_bot, FALSE) AS is_bot
         FROM clubs WHERE country = $1
         ORDER BY division ASC, is_bot ASC, name ASC`,
        [country],
      );
      if (!clubs || clubs.length < 2) continue;

      const eligible = [];
      for (const c of clubs) {
        const can = await friendlySystem.canPlayFriendly(c.id);
        if (!can.ok) continue;
        const has = await friendlySystem.hasFriendlyThisWeek(c.id, maxPerWeek);
        if (has) continue;
        eligible.push(c);
      }
      if (eligible.length < 2) continue;

      // Karıştır
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = eligible[i];
        eligible[i] = eligible[j];
        eligible[j] = tmp;
      }

      // Slot listesi
      const slots = [new Date(kickoffBase)];
      if (isPre && cal && typeof cal.nextSunday1300TR === "function") {
        const sun = cal.nextSunday1300TR(kickoffBase);
        // Aynı hafta içinde olsun
        if (sun.getTime() - kickoffBase.getTime() < 7 * 86400000) {
          slots.push(sun);
        } else {
          // kickoffBase'ten önceki pazar veya +3 gün civarı
          slots.push(new Date(kickoffBase.getTime() + 3 * 86400000));
        }
      }

      for (const slotKick of slots) {
        // Bu slot için yeniden eligible (limit)
        const pool = [];
        for (const c of eligible) {
          const has = await friendlySystem.hasFriendlyThisWeek(c.id, maxPerWeek);
          if (!has) pool.push(c);
        }
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = pool[i];
          pool[i] = pool[j];
          pool[j] = tmp;
        }
        let pairs = 0;
        for (
          let i = 0;
          i + 1 < pool.length && pairs < maxPairsPerCountry;
          i += 2
        ) {
          const home = pool[i];
          const away = pool[i + 1];
          // Aynı kickoff (kupa saati) — tüm çiftler aynı anda
          const kick = new Date(slotKick);
          try {
            const r = await friendlySystem.autoSchedule(home.id, away.id, kick);
            if (r && r.ok) {
              scheduled++;
              pairs++;
            } else {
              skipped++;
            }
          } catch (e) {
            skipped++;
          }
        }
      }
    } catch (e) {
      console.warn("[compBoot] friendly", country, e.message);
    }
  }

  return {
    scheduled,
    skipped,
    preSeasonCountries,
    kickoffAt: kickoffBase.toISOString(),
    slot: "Thursday 13:00 TR (Lig Kupası ile aynı)",
  };
}

/**
 * Tam bootstrap — boot ve admin full-reset sonrası.
 */
async function bootstrapAllCompetitions() {
  const started = Date.now();
  console.log("[compBoot] competitions bootstrap başlıyor…");
  const cups = await ensureAllCups();
  const cont = await ensureContinental();
  const nat = await ensureAllNational();
  const fr = await scheduleWeeklyFriendlies();
  const createdCups = cups.filter((c) => c.status === "created").length;
  console.log(
    "[compBoot] bitti",
    (Date.now() - started) + "ms",
    "cup+",
    createdCups,
    "continental",
    cont.status,
    "friendly+",
    fr.scheduled,
  );
  return { cups, continental: cont, national: nat, friendlies: fr };
}

module.exports = {
  currentYearLabel,
  ensureAllCups,
  ensureContinental,
  ensureAllNational,
  scheduleWeeklyFriendlies,
  bootstrapAllCompetitions,
};
