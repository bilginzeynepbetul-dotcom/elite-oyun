// ============================================================
// dailyChallengeSystem.js — Günlük görevler (P1 #13)
// ------------------------------------------------------------
// Her gün 3 görev (pool'dan hash ile seçilir).
// İlerleme hook: maç, transfer, antrenman, altyapı.
// ============================================================

const { query } = require("./db");
const clubsRepo = require("./repos/clubsRepo");

const REWARD_COMPLETE_ONE = 15_000;
const REWARD_ALL_THREE = 40_000;

/** Görev havuzu */
const POOL = [
  {
    id: "play_match",
    title: "Maça çık",
    desc: "1 resmi veya anlık maç tamamla",
    target: 1,
    icon: "⚽",
  },
  {
    id: "win_match",
    title: "Galibiyet",
    desc: "1 maç kazan",
    target: 1,
    icon: "🏆",
  },
  {
    id: "train_once",
    title: "Antrenman",
    desc: "1 antrenman yaptır",
    target: 1,
    icon: "🏋️",
  },
  {
    id: "bid_transfer",
    title: "Piyasa",
    desc: "Transferde 1 teklif ver",
    target: 1,
    icon: "💼",
  },
  {
    id: "youth_draw",
    title: "Altyapı",
    desc: "1 genç oyuncu keşfet",
    target: 1,
    icon: "🌱",
  },
  {
    id: "score_goals",
    title: "Gol",
    desc: "Takımın 2 gol atsın",
    target: 2,
    icon: "🎯",
  },
];

function dayKey(d) {
  d = d || new Date();
  return d.toISOString().slice(0, 10);
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Kullanıcı + gün için stabil 3 görev */
function pickDailyChallenges(userId, day) {
  const key = String(userId) + "|" + day;
  const h = hashStr(key);
  const pool = POOL.slice();
  const picked = [];
  let x = h;
  for (let i = 0; i < 3 && pool.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const idx = x % pool.length;
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

async function ensureRows(userId, day) {
  const defs = pickDailyChallenges(userId, day);
  for (const d of defs) {
    try {
      await query(
        `INSERT INTO daily_challenge_progress
           (user_id, day_key, challenge_id, progress, target, completed, claimed)
         VALUES ($1, $2, $3, 0, $4, FALSE, FALSE)
         ON CONFLICT (user_id, day_key, challenge_id) DO NOTHING`,
        [userId, day, d.id, d.target],
      );
    } catch (e) {
      if (e && e.code === "42P01") {
        console.warn("[dailyChallenge] tablo yok — migrate 026");
        return [];
      }
      throw e;
    }
  }
  return defs;
}

async function getStatus(userId) {
  if (!userId) return { ok: false, error: "auth" };
  const day = dayKey();
  const defs = await ensureRows(userId, day);
  if (!defs.length) {
    return {
      ok: true,
      day,
      challenges: [],
      allComplete: false,
      allClaimed: false,
      bonusAvailable: false,
    };
  }

  const { rows } = await query(
    `SELECT challenge_id AS id, progress, target, completed, claimed
     FROM daily_challenge_progress
     WHERE user_id = $1 AND day_key = $2`,
    [userId, day],
  );
  const byId = {};
  rows.forEach((r) => {
    byId[r.id] = r;
  });

  const challenges = defs.map((d) => {
    const r = byId[d.id] || {
      progress: 0,
      target: d.target,
      completed: false,
      claimed: false,
    };
    return {
      id: d.id,
      title: d.title,
      desc: d.desc,
      icon: d.icon,
      progress: Number(r.progress) || 0,
      target: Number(r.target) || d.target,
      completed: !!r.completed,
      claimed: !!r.claimed,
      reward: REWARD_COMPLETE_ONE,
    };
  });

  const allComplete = challenges.every((c) => c.completed);
  const allClaimed = challenges.every((c) => c.claimed);
  const bonusClaimed = await isBonusClaimed(userId, day);

  return {
    ok: true,
    day,
    challenges,
    allComplete,
    allClaimed,
    bonusAvailable: allComplete && !bonusClaimed,
    bonusReward: REWARD_ALL_THREE,
    bonusClaimed,
  };
}

async function isBonusClaimed(userId, day) {
  try {
    const { rows } = await query(
      `SELECT 1 FROM daily_challenge_progress
       WHERE user_id = $1 AND day_key = $2 AND challenge_id = '_bonus'
         AND claimed = TRUE LIMIT 1`,
      [userId, day],
    );
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * İlerleme ekle.
 */
async function addProgress(userId, challengeId, amount) {
  if (!userId || !challengeId) return null;
  amount = Math.max(1, Math.floor(Number(amount) || 1));
  const day = dayKey();
  await ensureRows(userId, day);

  try {
    const { rows } = await query(
      `UPDATE daily_challenge_progress SET
         progress = LEAST(target, progress + $4),
         updated_at = NOW()
       WHERE user_id = $1 AND day_key = $2 AND challenge_id = $3
         AND completed = FALSE
       RETURNING progress, target`,
      [userId, day, challengeId, amount],
    );
    if (!rows[0]) return null;
    const completed = Number(rows[0].progress) >= Number(rows[0].target);
    if (completed) {
      await query(
        `UPDATE daily_challenge_progress SET completed = TRUE
         WHERE user_id = $1 AND day_key = $2 AND challenge_id = $3`,
        [userId, day, challengeId],
      );
    }
    return {
      progress: rows[0].progress,
      target: rows[0].target,
      completed,
    };
  } catch (e) {
    if (e && e.code === "42P01") return null;
    return null;
  }
}

async function claim(userId, challengeId) {
  if (!userId) return { ok: false, error: "Giriş gerekli" };
  const day = dayKey();
  const club = await clubsRepo.getClubByUserId(userId);
  if (!club) return { ok: false, error: "Kulüp yok" };

  if (challengeId === "_bonus" || challengeId === "bonus") {
    const st = await getStatus(userId);
    if (!st.bonusAvailable) {
      return { ok: false, error: "Bonus henüz yok veya alındı" };
    }
    try {
      await query(
        `INSERT INTO daily_challenge_progress
           (user_id, day_key, challenge_id, progress, target, completed, claimed)
         VALUES ($1, $2, '_bonus', 1, 1, TRUE, TRUE)
         ON CONFLICT (user_id, day_key, challenge_id)
         DO UPDATE SET claimed = TRUE, completed = TRUE`,
        [userId, day],
      );
    } catch (e) {
      if (e && e.code === "42P01") {
        return { ok: false, error: "Migration gerekli (026)" };
      }
      throw e;
    }
    await clubsRepo.adjustBalance(
      club.id,
      REWARD_ALL_THREE,
      "Günlük görevler: 3/3 bonus",
    );
    return {
      ok: true,
      reward: REWARD_ALL_THREE,
      status: await getStatus(userId),
    };
  }

  const { rows } = await query(
    `UPDATE daily_challenge_progress SET claimed = TRUE, updated_at = NOW()
     WHERE user_id = $1 AND day_key = $2 AND challenge_id = $3
       AND completed = TRUE AND claimed = FALSE
     RETURNING challenge_id`,
    [userId, day, challengeId],
  );
  if (!rows.length) {
    return { ok: false, error: "Görev tamam değil veya ödül alınmış" };
  }
  await clubsRepo.adjustBalance(
    club.id,
    REWARD_COMPLETE_ONE,
    "Günlük görev: " + challengeId,
  );
  return {
    ok: true,
    reward: REWARD_COMPLETE_ONE,
    status: await getStatus(userId),
  };
}

// ---- Hooks ----

async function onMatchPlayed(userId, opts) {
  if (!userId) return;
  opts = opts || {};
  await addProgress(userId, "play_match", 1);
  if (opts.won) await addProgress(userId, "win_match", 1);
  if (opts.goals) await addProgress(userId, "score_goals", opts.goals);
}

async function onTrain(userId) {
  if (userId) await addProgress(userId, "train_once", 1);
}

async function onTransferBid(userId) {
  if (userId) await addProgress(userId, "bid_transfer", 1);
}

async function onYouthDraw(userId) {
  if (userId) await addProgress(userId, "youth_draw", 1);
}

async function userIdForClub(clubId) {
  if (!clubId) return null;
  try {
    const { rows } = await query(
      `SELECT user_id AS "userId" FROM clubs WHERE id = $1`,
      [clubId],
    );
    return (rows[0] && rows[0].userId) || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getStatus,
  claim,
  addProgress,
  onMatchPlayed,
  onTrain,
  onTransferBid,
  onYouthDraw,
  userIdForClub,
  dayKey,
  POOL,
  REWARD_COMPLETE_ONE,
  REWARD_ALL_THREE,
};
