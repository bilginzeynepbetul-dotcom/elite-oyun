// ============================================================
// calendarSchedule.js — lig maçları gerçek takvim slotlarına göre
// Saatler Europe/Istanbul (TR, UTC+3 sabit) olarak saklanır.
// Ülke yerel saatine göre uyku penceresine (00:00–08:59) düşmez.
// ============================================================
// Rezerve (tüm ülkeler, TR saati):
//   Çarşamba 15:00 TR — Kıtalar Ligi
//   Perşembe 13:00 TR — Lig Kupası
//   Cuma     22:00 TR — Milli takımlar
//
// Lig: ülke başına haftada 2 maç, aynı yerel saat bandı, ardışık gün YOK.
// ============================================================

const RESERVED = [
  { dow: 3, hour: 15, minute: 0, label: "Kıtalar Ligi" }, // Çarşamba
  { dow: 4, hour: 13, minute: 0, label: "Lig Kupası" }, // Perşembe
  { dow: 5, hour: 22, minute: 0, label: "Milli Takım" }, // Cuma
];

// Ardışık olmayan gün çiftleri (Pazar=0 … Cumartesi=6)
const DAY_PAIRS = [
  [0, 2], // Pazar + Salı
  [6, 1], // Cumartesi + Pazartesi
  [0, 3], // Pazar + Çarşamba
  [6, 2], // Cumartesi + Salı
  [0, 4], // Pazar + Perşembe
  [6, 5], // Cumartesi + Cuma
  [1, 5], // Pazartesi + Cuma
  [2, 6], // Salı + Cumartesi
  [0, 5], // Pazar + Cuma
  [1, 3], // Pazartesi + Çarşamba
  [2, 5], // Salı + Cuma
  [1, 4], // Pazartesi + Perşembe
];

// Tercih edilen yerel maç saatleri (uyku dışı: 09–23, ideal 14–21)
const PREFERRED_LOCAL_HOURS = [15, 16, 17, 18, 19, 20, 14, 21, 13, 12];

const COUNTRY_ORDER = [
  "Türkiye",
  "Almanya",
  "İngiltere",
  "İspanya",
  "İtalya",
  "Fransa",
  "Portekiz",
  "Hollanda",
  "Belçika",
  "İskoçya",
  "İrlanda",
  "Galler",
  "İsveç",
  "Norveç",
  "Danimarka",
  "İsviçre",
  "Avusturya",
  "Polonya",
  "Ukrayna",
  "Çekya",
  "Slovakya",
  "Macaristan",
  "Romanya",
  "Bulgaristan",
  "Yunanistan",
  "Hırvatistan",
  "Sırbistan",
  "Bosna-Hersek",
  "Arnavutluk",
  "Slovenya",
  "Rusya",
  "Finlandiya",
  "Brezilya",
  "Arjantin",
  "Uruguay",
  "Şili",
  "Kolombiya",
  "Ekvador",
  "Peru",
  "Paraguay",
  "Venezuela",
  "Meksika",
  "ABD",
  "Kanada",
  "Costa Rica",
  "Jamaika",
  "Japonya",
  "Güney Kore",
  "Çin",
  "Avustralya",
  "Suudi Arabistan",
  "İran",
  "Katar",
  "Hindistan",
  "Mısır",
  "Fas",
  "Nijerya",
  "Senegal",
  "Gana",
  "Kamerun",
  "Fildişi Sahili",
  "Cezayir",
  "Tunus",
  "Güney Afrika",
];

/** UTC ofset (saat). TR referans = +3. */
const COUNTRY_UTC_OFFSET = {
  Türkiye: 3,
  Almanya: 1,
  İngiltere: 0,
  İspanya: 1,
  İtalya: 1,
  Fransa: 1,
  Portekiz: 0,
  Hollanda: 1,
  Belçika: 1,
  İskoçya: 0,
  İrlanda: 0,
  Galler: 0,
  İsveç: 1,
  Norveç: 1,
  Danimarka: 1,
  İsviçre: 1,
  Avusturya: 1,
  Polonya: 1,
  Ukrayna: 2,
  Çekya: 1,
  Slovakya: 1,
  Macaristan: 1,
  Romanya: 2,
  Bulgaristan: 2,
  Yunanistan: 2,
  Hırvatistan: 1,
  Sırbistan: 1,
  "Bosna-Hersek": 1,
  Arnavutluk: 1,
  Slovenya: 1,
  Rusya: 3,
  Finlandiya: 2,
  Brezilya: -3,
  Arjantin: -3,
  Uruguay: -3,
  Şili: -4,
  Kolombiya: -5,
  Ekvador: -5,
  Peru: -5,
  Paraguay: -4,
  Venezuela: -4,
  Meksika: -6,
  ABD: -5,
  Kanada: -5,
  "Costa Rica": -6,
  Jamaika: -5,
  Japonya: 9,
  "Güney Kore": 9,
  Çin: 8,
  Avustralya: 10,
  "Suudi Arabistan": 3,
  İran: 3.5,
  Katar: 3,
  Hindistan: 5.5,
  Mısır: 2,
  Fas: 1,
  Nijerya: 1,
  Senegal: 0,
  Gana: 0,
  Kamerun: 1,
  "Fildişi Sahili": 0,
  Cezayir: 1,
  Tunus: 1,
  "Güney Afrika": 2,
};

const TR_UTC_OFFSET = 3;

/** Türkiye varsayılan: Pazar + Salı 14:00 TR (yerel 14:00) */
const DEFAULT_SLOTS = [
  { dow: 0, hour: 14, minute: 0 },
  { dow: 2, hour: 14, minute: 0 },
];

/** Yerel saat → TR saati (kickoffAtTR ile saklanır). */
function localHourToTR(localHour, utcOffset) {
  const off = Number(utcOffset);
  if (Number.isNaN(off)) return Math.floor(localHour) % 24;
  // TR_time = local + (TR_offset - local_offset)
  let tr = localHour + (TR_UTC_OFFSET - off);
  // Hindistan 5.5 → dakika taşıması
  let minute = 0;
  if (Math.abs(tr - Math.round(tr)) > 0.01) {
    minute = Math.round((tr - Math.floor(tr)) * 60);
    tr = Math.floor(tr);
  }
  while (tr < 0) tr += 24;
  while (tr >= 24) tr -= 24;
  return { hour: tr, minute: minute < 0 ? minute + 60 : minute };
}

/** TR saati → yerel saat (gösterim için). */
function trHourToLocal(trHour, trMinute, utcOffset) {
  const off = Number(utcOffset);
  if (Number.isNaN(off)) return { hour: trHour, minute: trMinute || 0 };
  let local = trHour + (off - TR_UTC_OFFSET) + (trMinute || 0) / 60;
  let minute = Math.round((local - Math.floor(local)) * 60);
  local = Math.floor(local);
  while (local < 0) local += 24;
  while (local >= 24) local -= 24;
  if (minute < 0) {
    minute += 60;
    local = (local + 23) % 24;
  }
  if (minute >= 60) {
    minute -= 60;
    local = (local + 1) % 24;
  }
  return { hour: local, minute };
}

function isSleepLocalHour(localHour) {
  // 00:00 – 08:59 uyku; maç koyma
  const h = Math.floor(localHour);
  return h >= 0 && h < 9;
}

function isReserved(dow, hour, minute) {
  const m = minute || 0;
  return RESERVED.some(
    (r) => r.dow === dow && r.hour === hour && (r.minute || 0) === m,
  );
}

function countryUtcOffset(country) {
  const name = String(country || "Türkiye").trim() || "Türkiye";
  if (COUNTRY_UTC_OFFSET[name] != null) return COUNTRY_UTC_OFFSET[name];
  return TR_UTC_OFFSET;
}

/**
 * Ülke için haftalık 2 slot: yerel uyanık saatlerde, TR'de saklanır.
 * Maç saatleri sabit ve öngörülebilir.
 */
function slotsForCountry(country) {
  const name = String(country || "Türkiye").trim() || "Türkiye";
  let idx = COUNTRY_ORDER.indexOf(name);
  if (idx < 0) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    idx = Math.abs(h) % DAY_PAIRS.length;
  }
  const pair = DAY_PAIRS[idx % DAY_PAIRS.length];
  const utcOff = countryUtcOffset(name);

  // Ülkeye sabit yerel saat seç (PREFERRED listesinden)
  let localHour = PREFERRED_LOCAL_HOURS[idx % PREFERRED_LOCAL_HOURS.length];
  let tr = localHourToTR(localHour, utcOff);
  let hour = tr.hour;
  let minute = tr.minute || 0;

  // Rezerve çakışması veya yerel uyku → kaydır (yerel saati koruyarak TR'de dolaş)
  for (let guard = 0; guard < 24; guard++) {
    const local = trHourToLocal(hour, minute, utcOff);
    const sleep = isSleepLocalHour(local.hour);
    const reserved =
      isReserved(pair[0], hour, minute) || isReserved(pair[1], hour, minute);
    if (!sleep && !reserved) break;
    // Bir sonraki tercih edilen yerel saate geç
    localHour = (localHour + 1) % 24;
    if (isSleepLocalHour(localHour)) localHour = 12; // uyku bandından atla
    tr = localHourToTR(localHour, utcOff);
    hour = tr.hour;
    minute = tr.minute || 0;
  }

  return [
    { dow: pair[0], hour, minute },
    { dow: pair[1], hour, minute },
  ];
}

/**
 * Kupa maçları için ülke slotları — Perşembe Lig Kupası rezervine saygı.
 * Haftada bir ana slot (daha seyrek): Pazar veya Çarşamba tercihi ülke indeksine göre.
 */
function cupSlotsForCountry(country) {
  const league = slotsForCountry(country);
  // Kupada aynı saat, farklı gün: lig günlerinden biri + 3 (mod 7) ama Perşembe 13 rezerve
  const base = league[0];
  let dow = (base.dow + 3) % 7;
  let hour = base.hour;
  let minute = base.minute || 0;
  const utcOff = countryUtcOffset(country);
  for (let guard = 0; guard < 14; guard++) {
    const local = trHourToLocal(hour, minute, utcOff);
    if (
      !isReserved(dow, hour, minute) &&
      !isSleepLocalHour(local.hour) &&
      dow !== 4 // Perşembe global Lig Kupası günü — mümkünse kaçın
    ) {
      break;
    }
    dow = (dow + 1) % 7;
  }
  return [{ dow, hour, minute }];
}

function parseSlots(raw) {
  if (!raw) return DEFAULT_SLOTS.slice();
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || !arr.length) return DEFAULT_SLOTS.slice();
    return arr
      .map((s) => ({
        dow: Number(s.dow),
        hour: Number(s.hour),
        minute: Number(s.minute) || 0,
      }))
      .filter(
        (s) =>
          s.dow >= 0 &&
          s.dow <= 6 &&
          s.hour >= 0 &&
          s.hour <= 23 &&
          s.minute >= 0 &&
          s.minute <= 59,
      );
  } catch (_) {
    return DEFAULT_SLOTS.slice();
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** dayDate'in Y-M-D bileşeninde TR saatiyle Date üret (UTC+3 sabit). */
function kickoffAtTR(dayDate, hour, minute) {
  const y = dayDate.getUTCFullYear();
  const m = dayDate.getUTCMonth();
  const d = dayDate.getUTCDate();
  const iso = `${y}-${pad2(m + 1)}-${pad2(d)}T${pad2(hour)}:${pad2(minute || 0)}:00+03:00`;
  return new Date(iso);
}

/**
 * seasonStartAt'ten itibaren N kickoff (TR slot saatleri).
 */
function generateKickoffSequence(seasonStartAt, count, slots) {
  const slotList = slots && slots.length ? slots : DEFAULT_SLOTS;
  const start = new Date(seasonStartAt);
  if (Number.isNaN(start.getTime()) || count <= 0) return [];

  const out = [];
  let day = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const maxMs = start.getTime() + 3 * 365 * 24 * 3600 * 1000;
  let guard = 0;

  while (out.length < count && day.getTime() < maxMs && guard++ < 8000) {
    const dow = day.getUTCDay(); // 0=Pazar
    const daySlots = slotList
      .filter((s) => s.dow === dow)
      .slice()
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

    for (const s of daySlots) {
      if (out.length >= count) break;
      const kick = kickoffAtTR(day, s.hour, s.minute || 0);
      if (kick.getTime() < start.getTime()) continue;
      out.push(kick);
    }
    day = new Date(day.getTime() + 24 * 3600 * 1000);
  }
  return out;
}

function assignKickoffsToFixtures(fixturePairs, seasonStartAt, slots) {
  const times = generateKickoffSequence(
    seasonStartAt,
    fixturePairs.length,
    slots,
  );
  return fixturePairs.map((f, i) => ({
    homeClubId: f.homeClubId,
    awayClubId: f.awayClubId,
    kickoffAt: times[i] || new Date(seasonStartAt.getTime() + i * 3600000),
  }));
}

/** UI / admin: ülke slot özeti (TR + yerel). */
function describeCountrySlots(country) {
  const slots = slotsForCountry(country);
  const off = countryUtcOffset(country);
  const DAY_NAMES = [
    "Pazar",
    "Pazartesi",
    "Salı",
    "Çarşamba",
    "Perşembe",
    "Cuma",
    "Cumartesi",
  ];
  return slots.map((s) => {
    const local = trHourToLocal(s.hour, s.minute || 0, off);
    return {
      dow: s.dow,
      dayName: DAY_NAMES[s.dow] || String(s.dow),
      hourTR: s.hour,
      minuteTR: s.minute || 0,
      hourLocal: local.hour,
      minuteLocal: local.minute,
      labelTR:
        (DAY_NAMES[s.dow] || "") +
        " " +
        pad2(s.hour) +
        ":" +
        pad2(s.minute || 0) +
        " TR",
      labelLocal:
        (DAY_NAMES[s.dow] || "") +
        " " +
        pad2(local.hour) +
        ":" +
        pad2(local.minute) +
        " yerel",
    };
  });
}

module.exports = {
  DEFAULT_SLOTS,
  RESERVED,
  DAY_PAIRS,
  COUNTRY_ORDER,
  COUNTRY_UTC_OFFSET,
  PREFERRED_LOCAL_HOURS,
  slotsForCountry,
  cupSlotsForCountry,
  parseSlots,
  generateKickoffSequence,
  assignKickoffsToFixtures,
  kickoffAtTR,
  isReserved,
  isSleepLocalHour,
  localHourToTR,
  trHourToLocal,
  countryUtcOffset,
  describeCountrySlots,
};
