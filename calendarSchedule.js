// ============================================================
// calendarSchedule.js — lig maçları gerçek takvim slotlarına göre
// 3 saat kuralı YOK. Sadece tanımlı gün/saatler.
// ============================================================
// Slot JSON: [ { dow: 0-6 (Pazar=0), hour, minute }, ... ]
// Varsayılan: Cmt 15:00, Cmt 18:00, Paz 15:00, Paz 18:00
// ============================================================

const DEFAULT_SLOTS = [
  { dow: 6, hour: 15, minute: 0 }, // Cumartesi
  { dow: 6, hour: 18, minute: 0 },
  { dow: 0, hour: 15, minute: 0 }, // Pazar
  { dow: 0, hour: 18, minute: 0 },
];

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

/**
 * seasonStartAt tarihinden itibaren, sıradaki N kickoff anını üretir.
 * Her slot = bir maç. Aynı günde birden fazla slot olabilir.
 */
function generateKickoffSequence(seasonStartAt, count, slots) {
  const slotList = slots && slots.length ? slots : DEFAULT_SLOTS;
  const start = new Date(seasonStartAt);
  if (Number.isNaN(start.getTime()) || count <= 0) return [];

  // seasonStart gününün 00:00'ından tarama (TR duyarlı değil; Date local/UTC karışmasın diye
  // seasonStart'ın kendisini referans alıp gün gün ilerleriz).
  const out = [];
  // Tarama başlangıcı: start günü (saat sıfırlanmadan, gün döngüsü)
  let day = new Date(start);
  day.setHours(0, 0, 0, 0);

  // Güvenlik: max 3 yıl
  const maxMs = start.getTime() + 3 * 365 * 24 * 3600 * 1000;
  let guard = 0;

  while (out.length < count && day.getTime() < maxMs && guard++ < 5000) {
    const dow = day.getDay();
    const daySlots = slotList
      .filter((s) => s.dow === dow)
      .slice()
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

    for (const s of daySlots) {
      if (out.length >= count) break;
      const kick = new Date(day);
      kick.setHours(s.hour, s.minute, 0, 0);
      // Sezon başlangıcından önceye düşen slotları atla
      if (kick.getTime() < start.getTime()) continue;
      out.push(kick);
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/**
 * Round-robin eşleşmeleri + takvim kickoff birleştir.
 */
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

module.exports = {
  DEFAULT_SLOTS,
  parseSlots,
  generateKickoffSequence,
  assignKickoffsToFixtures,
};
