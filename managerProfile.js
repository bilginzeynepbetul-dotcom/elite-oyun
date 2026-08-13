// ============================================================
// managerProfile.js — genel menajer profili (kendi / başkası)
// ============================================================

const { query } = require("./db");
const premiumSystem = require("./premiumSystem");

/** UUID → stabil üye no (authRoutes.userNoFromId ile aynı mantık) */
function userNoFromId(id) {
  const s = String(id || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 10000 + (h >>> 0) % 90000;
}

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/**
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function getByUsername(username) {
  const uname = String(username || "").trim();
  if (!uname) return null;

  const { rows: userRows } = await query(
    `SELECT id, username, created_at
     FROM users
     WHERE LOWER(username) = LOWER($1)
     LIMIT 1`,
    [uname],
  );
  const user = userRows[0];
  if (!user) return null;

  const { rows: clubRows } = await query(
    `SELECT id, name, country, division, second_team,
            COALESCE(is_bot, FALSE) AS is_bot
     FROM clubs
     WHERE user_id = $1
     ORDER BY created_at ASC NULLS LAST
     LIMIT 1`,
    [user.id],
  );
  const club = clubRows[0] || null;

  let elite = { active: false, plan: null, until: null };
  try {
    elite = await premiumSystem.getStatus(user.id);
  } catch (_) {}

  let stats = {
    matches: 0,
    wins: 0,
    draws: 0,
    losses: 0,
  };
  let form = [];
  let leagueRank = null;
  let leaguePts = null;
  let seasonLabel = null;

  if (club && club.id) {
    // Maç arşivinden W/D/L + form
    const { rows: matches } = await query(
      `SELECT home_club_id AS "homeClubId",
              away_club_id AS "awayClubId",
              home_goals AS "homeGoals",
              away_goals AS "awayGoals",
              home_name AS "homeName",
              away_name AS "awayName",
              competition,
              finished_at AS "finishedAt"
       FROM match_results
       WHERE home_club_id = $1 OR away_club_id = $1
       ORDER BY finished_at DESC
       LIMIT 50`,
      [club.id],
    );

    const cid = String(club.id);
    for (const m of matches) {
      const isHome = m.homeClubId && String(m.homeClubId) === cid;
      const hg = Number(m.homeGoals) || 0;
      const ag = Number(m.awayGoals) || 0;
      let result = "B";
      if (isHome) {
        if (hg > ag) result = "G";
        else if (hg < ag) result = "M";
      } else {
        if (ag > hg) result = "G";
        else if (ag < hg) result = "M";
      }
      stats.matches++;
      if (result === "G") stats.wins++;
      else if (result === "B") stats.draws++;
      else stats.losses++;

      if (form.length < 10) {
        const opp = isHome
          ? m.awayName || "Rakip"
          : m.homeName || "Rakip";
        form.push({
          result,
          score: hg + "-" + ag,
          opp,
          competition: m.competition || "league",
          finishedAt: m.finishedAt,
        });
      }
    }

    // Lig sıralaması (güncel sezon)
    try {
      const { rows: standRows } = await query(
        `SELECT ls.played, ls.won, ls.drawn, ls.lost, ls.pts,
                s.year_label AS "yearLabel",
                (
                  SELECT COUNT(*)::int + 1
                  FROM league_standings ls2
                  WHERE ls2.season_id = ls.season_id
                    AND (
                      ls2.pts > ls.pts
                      OR (ls2.pts = ls.pts AND (ls2.gf - ls2.ga) > (ls.gf - ls.ga))
                      OR (ls2.pts = ls.pts AND (ls2.gf - ls2.ga) = (ls.gf - ls.ga) AND ls2.gf > ls.gf)
                    )
                ) AS rank,
                (
                  SELECT COUNT(*)::int FROM league_standings ls3
                  WHERE ls3.season_id = ls.season_id
                ) AS total
         FROM league_standings ls
         JOIN seasons s ON s.id = ls.season_id
         WHERE ls.club_id = $1 AND s.is_current = TRUE
         ORDER BY s.id DESC
         LIMIT 1`,
        [club.id],
      );
      if (standRows[0]) {
        const r = standRows[0];
        leagueRank =
          r.rank && r.total
            ? r.rank + " / " + r.total
            : r.rank
              ? String(r.rank)
              : null;
        leaguePts = r.pts != null ? Number(r.pts) : null;
        seasonLabel = r.yearLabel || null;
        // Arşiv boşsa lig tablosundan da doldur
        if (stats.matches === 0 && r.played) {
          stats.matches = Number(r.played) || 0;
          stats.wins = Number(r.won) || 0;
          stats.draws = Number(r.drawn) || 0;
          stats.losses = Number(r.lost) || 0;
        }
      }
    } catch (e) {
      console.warn("[managerProfile] standings", e.message);
    }
  }

  let secondTeamLabel = "Yok";
  if (club && club.second_team) {
    try {
      const st =
        typeof club.second_team === "string"
          ? JSON.parse(club.second_team)
          : club.second_team;
      if (st && (st.name || st.teamName)) {
        secondTeamLabel = st.name || st.teamName;
      } else if (st && st.active) {
        secondTeamLabel = "Aktif";
      }
    } catch (_) {
      secondTeamLabel = "Var";
    }
  }

  const winRate =
    stats.matches > 0
      ? Math.round((stats.wins / stats.matches) * 100)
      : null;

  return {
    userId: user.id,
    username: user.username,
    userNo: userNoFromId(user.id),
    createdAt: user.created_at || null,
    careerDays: daysSince(user.created_at),
    elite: !!(elite && elite.active),
    elitePlan: (elite && elite.plan) || null,
    club: club
      ? {
          id: club.id,
          name: club.name,
          country: club.country,
          division: club.division,
        }
      : null,
    teamName: club ? club.name : null,
    country: club ? club.country : null,
    division: club ? club.division : null,
    secondTeam: secondTeamLabel,
    matches: stats.matches,
    wins: stats.wins,
    draws: stats.draws,
    losses: stats.losses,
    winRate,
    leagueRank,
    leaguePts,
    seasonLabel,
    form,
  };
}

module.exports = { getByUsername, userNoFromId };
