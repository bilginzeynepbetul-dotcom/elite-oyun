// ============================================================
// staffSystem.js — antrenör + doktor + sakatlık kalıcılığı
// ============================================================

const { query } = require("./db");
const clubsRepo = require("./repos/clubsRepo");
const trainingRepo = require("./repos/trainingRepo");
const economy = require("./economyBalance");

const SKILL_LABELS = {
  pace: "Hız",
  passing: "Pas",
  finishing: "Bitiricilik",
  tackle: "Müdahale",
  vision: "Vizyon",
  stamina: "Dayanıklılık",
  strength: "Güç",
  technique: "Teknik",
  agility: "Çeviklik",
  positioning: "Pozisyon",
  reflex: "Refleks",
  handling: "Tutuş",
};

async function listCoaches(clubId) {
  const state = await trainingRepo.getTrainingState(clubId);
  return (state && state.coaches) || [];
}

async function hireCoach(clubId, skill, level) {
  const sk = String(skill || "stamina").toLowerCase();
  const lv = Math.max(1, Math.min(5, parseInt(level, 10) || 1));
  const salary =
    typeof economy.coachSalaryCalibrated === "function"
      ? economy.coachSalaryCalibrated(lv)
      : 5000 + lv * 3000;

  const club = await clubsRepo.getClub(clubId);
  if (!club) return { ok: false, error: "Kulüp yok" };
  if (Number(club.balance) < salary * 2) {
    return { ok: false, error: "Yetersiz bakiye (2 haftalık maaş peşin)" };
  }

  const existing = await listCoaches(clubId);
  if (existing.some((c) => c.skill === sk)) {
    return { ok: false, error: "Bu branşta antrenör zaten var" };
  }
  if (existing.length >= 4) {
    return { ok: false, error: "En fazla 4 antrenör" };
  }

  const paidOk = await clubsRepo.adjustBalance(
    clubId,
    -(salary * 2),
    "Antrenör işe alım",
  );
  // GÜVENLİK: adjustBalance içeride FOR UPDATE ile atomik kontrol yapıyor —
  // üstteki ön-kontrol (satır 40) sadece iyimser bir kontrol, gerçek garanti
  // burada. Sonuç kontrol edilmezse eşzamanlı isteklerle (4 farklı branş için
  // aynı anda istek atarak) bakiye yetmediği halde antrenör eklenebiliyordu.
  if (!paidOk) {
    return { ok: false, error: "Yetersiz bakiye (2 haftalık maaş peşin)" };
  }
  const name = (SKILL_LABELS[sk] || sk) + " Antrenörü Lv" + lv;
  await query(
    `INSERT INTO club_coaches (club_id, skill, level, salary, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (club_id, skill) DO UPDATE SET
       level = EXCLUDED.level, salary = EXCLUDED.salary, name = EXCLUDED.name`,
    [clubId, sk, lv, salary, name],
  );
  const coaches = await listCoaches(clubId);
  return { ok: true, coaches, coach: coaches.find((c) => c.skill === sk) };
}

async function removeCoach(clubId, skill) {
  const sk = String(skill || "").toLowerCase();
  await query(`DELETE FROM club_coaches WHERE club_id = $1 AND skill = $2`, [
    clubId,
    sk,
  ]);
  return { ok: true, coaches: await listCoaches(clubId) };
}

async function getDoctor(clubId) {
  const { rows } = await query(
    `SELECT id, name, spec, level, salary FROM club_doctors WHERE club_id = $1`,
    [clubId],
  );
  return rows[0] || null;
}

async function ensureDoctor(clubId) {
  let d = await getDoctor(clubId);
  if (d) return d;
  await query(
    `INSERT INTO club_doctors (club_id, name, spec, level, salary)
     VALUES ($1, 'Dr. Yılmaz', 'genel', 1, 3000)
     ON CONFLICT DO NOTHING`,
    [clubId],
  );
  return getDoctor(clubId);
}

/** Maç sonu sakatlıkları DB'ye yaz */
async function persistMatchInjuries(clubId, players) {
  if (!clubId || !Array.isArray(players)) return;
  for (const p of players) {
    if (!p || !p.id) continue;
    if (p.injured || (p.injuryDaysLeft && p.injuryDaysLeft > 0)) {
      const days = Math.max(
        1,
        Math.min(30, Number(p.injuryDaysLeft) || 3 + Math.floor(Math.random() * 5)),
      );
      await query(
        `UPDATE players SET injured = TRUE, injury_days_left = $2 WHERE id = $1 AND club_id = $3`,
        [p.id, days, clubId],
      );
    }
  }
}

/** Doktor seviyesine göre iyileşme adımı */
async function processRecovery(clubId) {
  if (!clubId) return;
  const doc = await ensureDoctor(clubId);
  const reduce = doc ? Math.max(1, Number(doc.level) || 1) : 1;
  await query(
    `UPDATE players SET
       injury_days_left = GREATEST(0, injury_days_left - $2),
       injured = CASE WHEN injury_days_left - $2 <= 0 THEN FALSE ELSE injured END
     WHERE club_id = $1 AND (injured = TRUE OR injury_days_left > 0)`,
    [clubId, reduce],
  );
  await query(
    `UPDATE players SET injured = FALSE, injury_days_left = 0
     WHERE club_id = $1 AND injury_days_left <= 0`,
    [clubId],
  );
}

module.exports = {
  listCoaches,
  hireCoach,
  removeCoach,
  getDoctor,
  ensureDoctor,
  persistMatchInjuries,
  processRecovery,
  SKILL_LABELS,
};
