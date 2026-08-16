// ============================================================
// countries.js — Desteklenen ülkeler listesi
// calendarSchedule.COUNTRY_ORDER ile senkron tutulmalı.
// ============================================================

const SUPPORTED_COUNTRIES = [
  "Türkiye",
  "Almanya",
  "Fransa",
  "Portekiz",
  "Hollanda",
  "Belçika",
  "Brezilya",
  "Arjantin",
  "Meksika",
  "Japonya",
  "Avustralya",
  "Mısır",
  "Fas",
  "Nijerya",
  "Güney Afrika",
  "Rusya",
  "Polonya",
  "Ukrayna",
  "Yunanistan",
  "Norveç",
  "Danimarka",
  "Avusturya",
  "Hırvatistan",
  "Sırbistan",
  "Arnavutluk",
  "Slovenya",
  "Bulgaristan",
  "Romanya",
  "Hindistan",
];

function isSupportedCountry(name) {
  if (!name || typeof name !== "string") return false;
  const n = name.trim();
  return SUPPORTED_COUNTRIES.some((c) => c.toLowerCase() === n.toLowerCase());
}

function normalizeCountry(name) {
  if (!name || typeof name !== "string") return "Türkiye";
  const n = name.trim();
  const found = SUPPORTED_COUNTRIES.find(
    (c) => c.toLowerCase() === n.toLowerCase(),
  );
  return found || "Türkiye";
}

module.exports = {
  SUPPORTED_COUNTRIES,
  isSupportedCountry,
  normalizeCountry,
};
