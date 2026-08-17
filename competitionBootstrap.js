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

/** Kıtasal turnuva — yoksa oluştur */
async function ensureContinental() {
  try {
    if (typeof continentalRepo.getCurrentEdition === "function") {
      const cur = await continentalRepo.getCurrentEdition();
      if (cur) return { status: "exists", id: cur.id };
    }
    const yearLabel = currentYearLabel();
    if (typeof continentalRepo.ensureEditionExists === "function") {
      const r = await continentalRepo.ensureEditionExists(yearLabel);
      return { status: "ensured", result: r };
    }
    if (typeof continentalRepo.createEdition === "function") {
      const r = await continentalRepo.createEdition(yearLabel);
      return { status: "created", result: r };
    }
    return { status: "skip", reason: "API yok" };
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
 * - Kupada aktif maçı olmayan (elenen / kupaya girmemiş) takımlar
 * - Bu hafta zaten dostluğu olanlar atlanır
 * - Çiftler eşleştirilir, status=scheduled (onay beklemeden — canlı oyun)
 * - Haftada en fazla 1 dostluk / kulüp
 */
async function scheduleWeeklyFriendlies(opts = {}) {
  const maxPairsPerCountry = opts.maxPairsPerCountry || 20;
  let kickoffBase = opts.kickoffBase;
  if (!kickoffBase) {
    try {
      const seasonConfig = require("./seasonConfig");
      kickoffBase = await seasonConfig.getSeasonStartAt();
    } catch (_) {
      kickoffBase = new Date(Date.now() + 90 * 60 * 1000);
    }
    // Dostluk: sezon başlangıcından ~2 saat sonra (kupa ile çakışmasın)
    kickoffBase = new Date(kickoffBase.getTime() + 2 * 60 * 60 * 1000);
    if (kickoffBase.getTime() < Date.now() + 30 * 60 * 1000) {
      kickoffBase = new Date(Date.now() + 90 * 60 * 1000);
    }
  }

  let scheduled = 0;
  let skipped = 0;

  for (const country of SUPPORTED_COUNTRIES) {
    try {
      // Ülkedeki insan + bot kulüpler
      const { rows: clubs } = await query(
        `SELECT id, name, is_bot FROM clubs WHERE country = $1 ORDER BY is_bot ASC, name ASC`,
        [country],
      );
      if (!clubs || clubs.length < 2) continue;

      const eligible = [];
      for (const c of clubs) {
        const can = await friendlySystem.canPlayFriendly(c.id);
        if (!can.ok) continue;
        // Bu hafta zaten dostluk var mı?
        const hasWeek = await friendlySystem.hasFriendlyThisWeek(c.id);
        if (hasWeek) continue;
        eligible.push(c);
      }

      // Karıştır
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = eligible[i];
        eligible[i] = eligible[j];
        eligible[j] = tmp;
      }

      let pairs = 0;
      for (let i = 0; i + 1 < eligible.length && pairs < maxPairsPerCountry; i += 2) {
        const home = eligible[i];
        const away = eligible[i + 1];
        const kick = new Date(
          kickoffBase.getTime() + pairs * 15 * 60 * 1000 + Math.floor(Math.random() * 5) * 60000,
        );
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
    } catch (e) {
      console.warn("[compBoot] friendly", country, e.message);
    }
  }

  return { scheduled, skipped };
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
