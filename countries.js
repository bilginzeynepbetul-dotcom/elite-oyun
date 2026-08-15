// ============================================================
// countries.js — kayıtta seçilebilen ülkeler (her biri 1. lig, 8 takım)
// public/index.html içindeki COUNTRY_DATA ile aynı liste; UI'daki
// ülke seçimi (regCountry) burayla senkron tutulmalı.
// ============================================================

const SUPPORTED_COUNTRIES = [
  "Türkiye", "Almanya", "Fransa", "Portekiz", "Hollanda", "Belçika",
  "Brezilya", "Arjantin", "Meksika", "Japonya", "Avustralya", "Mısır",
  "Fas", "Nijerya", "Güney Afrika", "Rusya", "Polonya", "Ukrayna", "Yunanistan",
  "Norveç", "Danimarka", "Avusturya", "Hırvatistan", "Sırbistan",
  "Arnavutluk", "Slovenya", "Bulgaristan", "Romanya", "Hindistan",
];

const DEFAULT_COUNTRY = "Türkiye";

function isSupportedCountry(country) {
  return SUPPORTED_COUNTRIES.includes(country);
}

module.exports = { SUPPORTED_COUNTRIES, DEFAULT_COUNTRY, isSupportedCountry };
