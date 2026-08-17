// ============================================================
// countries.js — Desteklenen ülkeler listesi (64)
// Milli eleme: 16 grup × 4 takım (torba sistemi).
// calendarSchedule.COUNTRY_ORDER ile senkron tutulmalı.
// ============================================================

const SUPPORTED_COUNTRIES = [
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
  "Güney Afrika"
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
