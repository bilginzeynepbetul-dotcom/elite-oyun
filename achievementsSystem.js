// ============================================================
// achievementsSystem.js — Başarılar / trofeler (P1 #10)
// ------------------------------------------------------------
// Tanımlar + unlock + list. Hook: maç sonu, sezon, transfer, vs.
// ============================================================

const { query } = require("./db");

/** @type {Record<string, { id, title, desc, icon, category }>} */
const DEFS = {
  first_win: {
    id: "first_win",
    title: "İlk Zafer",
    desc: "Resmi bir maç kazan",
    icon: "⚽",
    category: "match",
  },
  win_streak_3: {
    id: "win_streak_3",
    title: "Seri Peşinde",
    desc: "Üst üste 3 maç kazan",
    icon: "🔥",
    category: "match",
  },
  win_streak_5: {
    id: "win_streak_5",
    title: "Durdurulamaz",
    desc: "Üst üste 5 maç kazan",
    icon: "💥",
    category: "match",
  },
  clean_sheet: {
    id: "clean_sheet",
    title: "Duvar",
    desc: "Bir maçı gol yemeden kazan",
    icon: "🧤",
    category: "match",
  },
  big_win: {
    id: "big_win",
    title: "Fark Maçı",
    desc: "3+ farkla kazan",
    icon: "🎯",
    category: "match",
  },
  league_champion: {
    id: "league_champion",
    title: "Şampiyon",
    desc: "Ligi şampiyon bitir",
    icon: "🏆",
    category: "season",
  },
  promotion: {
    id: "promotion",
    title: "Yükselme",
    desc: "Bir üst lige çık",
    icon: "⬆️",
    category: "season",
  },
  first_transfer_buy: {
    id: "first_transfer_buy",
    title: "İlk Transfer",
    desc: "Piyasadan oyuncu al",
    icon: "💼",
    category: "transfer",
  },
  first_transfer_sell: {
    id: "first_transfer_sell",
    title: "İlk Satış",
    desc: "Oyuncu sat",
    icon: "💰",
    category: "transfer",
  },
  youth_graduate: {
    id: "youth_graduate",
    title: "Altyapı",
    desc: "Genç oyuncuyu A takıma al",
    icon: "🌱",
    category: "youth",
  },
  elite_member: {
    id: "elite_member",
    title: "Elite",
    desc: "Elite üyelik aktif et",
    icon: "⭐",
    category: "meta",
  },
  matches_10: {
    id: "matches_10",
    title: "Tecrübeli",
    desc: "10 resmi maç tamamla",
    icon: "📋",
    category: "match",
  },
  matches_50: {
    id: "matches_50",
    title: "Veteran",
    desc: "50 resmi maç tamamla",
    icon: "🎖️",
    category: "match",
  },
};

function allDefs() {
  return Object.values(DEFS);
}

async function listUnlocked(userId) {
  if (!userId) return [];
  try {
    const { rows } = await query(
      `SELECT achievement_id AS id, unlocked_at AS "unlockedAt", meta
       FROM user_achievements WHERE user_id = $1
       ORDER BY unlocked_at DESC`,
      [userId],
    );
    return rows;
  } catch (e) {
    // tablo yoksa boş
    if (e && e.code === "42P01") return [];
    throw e;
  }
}

async function hasAchievement(userId, achievementId) {
  if (!userId || !achievementId) return false;
  try {
    const { rows } = await query(
      `SELECT 1 FROM user_achievements
       WHERE user_id = $1 AND achievement_id = $2 LIMIT 1`,
      [userId, achievementId],
    );
    return rows.length > 0;
  } catch (e) {
    if (e && e.code === "42P01") return false;
    return false;
  }
}

/**
 * Başarı aç; zaten varsa null döner.
 * Bildirim + social push (opsiyonel).
 */
async function unlock(userId, achievementId, meta) {
  if (!userId || !DEFS[achievementId]) return null;
  if (await hasAchievement(userId, achievementId)) return null;

  const def = DEFS[achievementId];
  try {
    await query(
      `INSERT INTO user_achievements (user_id, achievement_id, meta)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT DO NOTHING`,
      [userId, achievementId, JSON.stringify(meta || {})],
    );
  } catch (e) {
    if (e && e.code === "42P01") {
      console.warn("[achievements] tablo yok — migrate 025 çalıştırın");
      return null;
    }
    // concurrent unlock
    if (e && e.code === "23505") return null;
    throw e;
  }

  // Bildirim
  try {
    const social = require("./socialSystem");
    if (social && typeof social.pushNotification === "function") {
      await social.pushNotification(
        userId,
        def.icon || "🏅",
        "Başarı açıldı: " + def.title + " — " + def.desc,
        "achievement",
      );
    }
  } catch (_) {}

  return { ...def, unlockedAt: new Date().toISOString(), meta: meta || {} };
}

async function getProfile(userId) {
  const unlocked = await listUnlocked(userId);
  const unlockedIds = new Set(unlocked.map((u) => u.id));
  const items = allDefs().map((d) => ({
    ...d,
    unlocked: unlockedIds.has(d.id),
    unlockedAt:
      (unlocked.find((u) => u.id === d.id) || {}).unlockedAt || null,
  }));
  return {
    total: items.length,
    unlockedCount: unlocked.length,
    items,
  };
}

/** userId club üzerinden */
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

/**
 * Maç sonucu sonrası (league/cup/instant).
 * @param {object} opts { homeClubId, awayClubId, homeGoals, awayGoals, competition }
 */
async function onMatchResult(opts) {
  opts = opts || {};
  const hg = Number(opts.homeGoals) || 0;
  const ag = Number(opts.awayGoals) || 0;
  const sides = [
    {
      clubId: opts.homeClubId,
      gf: hg,
      ga: ag,
      won: hg > ag,
      draw: hg === ag,
    },
    {
      clubId: opts.awayClubId,
      gf: ag,
      ga: hg,
      won: ag > hg,
      draw: hg === ag,
    },
  ];

  for (const s of sides) {
    if (!s.clubId) continue;
    const uid = await userIdForClub(s.clubId);
    if (!uid) continue;

    // Maç sayacı (meta basit — her maçta matches_played artırılamaz kolayca;
    // archive count ile kontrol)
    try {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM match_archive
         WHERE home_club_id = $1 OR away_club_id = $1`,
        [s.clubId],
      );
      const c = (rows[0] && rows[0].c) || 0;
      if (c >= 10) await unlock(uid, "matches_10", { matches: c });
      if (c >= 50) await unlock(uid, "matches_50", { matches: c });
    } catch (_) {}

    if (s.won) {
      await unlock(uid, "first_win", { competition: opts.competition });
      if (s.ga === 0) await unlock(uid, "clean_sheet");
      if (s.gf - s.ga >= 3) await unlock(uid, "big_win", { gf: s.gf, ga: s.ga });

      // Seri: son 5 arşiv
      try {
        const { rows } = await query(
          `SELECT home_club_id AS h, away_club_id AS a,
                  home_goals AS hg, away_goals AS ag
           FROM match_archive
           WHERE home_club_id = $1 OR away_club_id = $1
           ORDER BY played_at DESC NULLS LAST, id DESC
           LIMIT 5`,
          [s.clubId],
        );
        let streak = 0;
        for (const m of rows) {
          const isHome = String(m.h) === String(s.clubId);
          const gf = isHome ? Number(m.hg) : Number(m.ag);
          const ga = isHome ? Number(m.ag) : Number(m.hg);
          if (gf > ga) streak++;
          else break;
        }
        if (streak >= 3) await unlock(uid, "win_streak_3", { streak });
        if (streak >= 5) await unlock(uid, "win_streak_5", { streak });
      } catch (_) {}
    }
  }
}

async function onLeagueChampion(clubId) {
  const uid = await userIdForClub(clubId);
  if (uid) await unlock(uid, "league_champion");
}

async function onPromotion(clubId) {
  const uid = await userIdForClub(clubId);
  if (uid) await unlock(uid, "promotion");
}

async function onTransferBuy(userId) {
  if (userId) await unlock(userId, "first_transfer_buy");
}

async function onTransferSell(userId) {
  if (userId) await unlock(userId, "first_transfer_sell");
}

async function onYouthPromote(userId) {
  if (userId) await unlock(userId, "youth_graduate");
}

async function onEliteActivated(userId) {
  if (userId) await unlock(userId, "elite_member");
}

module.exports = {
  DEFS,
  allDefs,
  listUnlocked,
  hasAchievement,
  unlock,
  getProfile,
  onMatchResult,
  onLeagueChampion,
  onPromotion,
  onTransferBuy,
  onTransferSell,
  onYouthPromote,
  onEliteActivated,
  userIdForClub,
};
