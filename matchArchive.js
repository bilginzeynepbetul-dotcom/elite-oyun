// ============================================================
// matchArchive.js — Maç özeti + olayların PostgreSQL'e yazılması
// ------------------------------------------------------------
// "Veritabanı" = PostgreSQL (Supabase). Kalıcı tek kaynak burası.
//
// Kaydedilenler:
//   • Skor, takımlar, competition tipi
//   • stats (şut, isabet, top hakimiyeti …)
//   • scorers (gol + asist listesi)
//   • events / match_logs (dakika + metin)
//
// Kaydedilmeyenler (bilinçli):
//   • Her tick top x/y koordinatı (çok veri, canlı izleme için Socket yeterli)
// ============================================================

const { query, withTransaction } = require("./db");

/**
 * state: Match.getPublicState()
 * matchInstance: Match (opsiyonel — scorers/log için)
 * meta: { competition, fixtureId, externalId, homeClubId, awayClubId, homeName, awayName }
 */
async function persistMatch(state, matchInstance, meta = {}) {
  if (!state) return { ok: false, error: "state yok" };

  const competition = meta.competition || "league";
  const fixtureId = meta.fixtureId || state.fixtureId || null;
  const externalId =
    meta.externalId ||
    (competition !== "league" ? String(fixtureId || "") : null) ||
    null;

  const homeGoals =
    state.score && state.score.home != null ? state.score.home : 0;
  const awayGoals =
    state.score && state.score.away != null ? state.score.away : 0;

  const homeClubId = meta.homeClubId || null;
  const awayClubId = meta.awayClubId || null;
  const homeName =
    meta.homeName ||
    (state.players && state.players.home && state.players.home.teamName) ||
    null;
  const awayName =
    meta.awayName ||
    (state.players && state.players.away && state.players.away.teamName) ||
    null;

  const scorers =
    (matchInstance && matchInstance.scorers) ||
    (state.scorers) ||
    [];

  const stats = buildStats(state, matchInstance);
  const logLines = collectLogs(state, matchInstance);
  const events = buildEvents(scorers, logLines);

  try {
    const matchRowId = await withTransaction(async (client) => {
      // Lig: fixture_id unique. Diğer: external_id + competition
      let matchId = null;

      if (competition === "league" && fixtureId) {
        const { rows } = await client.query(
          `INSERT INTO match_results
             (fixture_id, home_club_id, away_club_id, home_goals, away_goals,
              stats, scorers, competition, external_id, home_name, away_name, events)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb)
           ON CONFLICT (fixture_id) DO UPDATE SET
             home_goals = EXCLUDED.home_goals,
             away_goals = EXCLUDED.away_goals,
             stats = EXCLUDED.stats,
             scorers = EXCLUDED.scorers,
             events = EXCLUDED.events,
             home_name = COALESCE(EXCLUDED.home_name, match_results.home_name),
             away_name = COALESCE(EXCLUDED.away_name, match_results.away_name),
             finished_at = NOW()
           RETURNING id`,
          [
            fixtureId,
            homeClubId,
            awayClubId,
            homeGoals,
            awayGoals,
            JSON.stringify(stats),
            JSON.stringify(scorers),
            competition,
            externalId,
            homeName,
            awayName,
            JSON.stringify(events),
          ],
        );
        matchId = rows[0].id;
      } else {
        // fixture_id null veya non-league — home/away club zorunlu şemada
        // Kulüp id yoksa placeholder bot id kullanılamaz; NULL izin yok.
        // external_id ile önceki kaydı silip yeniden yaz.
        if (externalId) {
          await client.query(
            `DELETE FROM match_results
             WHERE competition = $1 AND external_id = $2`,
            [competition, String(externalId)],
          );
        }
        // home_club_id NOT NULL — id yoksa atla
        if (!homeClubId || !awayClubId) {
          // Sadece log: kulüp id olmadan arşiv zor
          return null;
        }
        const { rows } = await client.query(
          `INSERT INTO match_results
             (fixture_id, home_club_id, away_club_id, home_goals, away_goals,
              stats, scorers, competition, external_id, home_name, away_name, events)
           VALUES (NULL,$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb)
           RETURNING id`,
          [
            homeClubId,
            awayClubId,
            homeGoals,
            awayGoals,
            JSON.stringify(stats),
            JSON.stringify(scorers),
            competition,
            externalId ? String(externalId) : null,
            homeName,
            awayName,
            JSON.stringify(events),
          ],
        );
        matchId = rows[0].id;
      }

      if (matchId && logLines.length) {
        // Eski logları temizle (yeniden yazım)
        await client.query(`DELETE FROM match_logs WHERE match_id = $1`, [
          matchId,
        ]);
        for (const line of logLines.slice(0, 200)) {
          await client.query(
            `INSERT INTO match_logs (match_id, minute, text, event_type, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              matchId,
              line.minute != null ? line.minute : null,
              line.text || "",
              line.type || "log",
              JSON.stringify(line.payload || {}),
            ],
          );
        }
      }

      return matchId;
    });

    return { ok: true, matchId: matchRowId, competition, events: events.length };
  } catch (e) {
    console.error("[matchArchive] persist", e.message);
    return { ok: false, error: e.message };
  }
}

function buildStats(state, match) {
  const out = {
    minute: state.minute || 90,
    score: state.score || { home: 0, away: 0 },
  };
  if (state.stats) {
    out.shots = state.stats;
  }
  if (match && match.stats) {
    out.engineStats = match.stats;
  }
  // possession ticks if present
  if (match && match.possessionTicks) {
    out.possessionTicks = match.possessionTicks;
  }
  return out;
}

function collectLogs(state, match) {
  const lines = [];
  // match.log dizisi
  const src =
    (match && (match.log || match.logs || match.eventLog)) ||
    (state && state.logs) ||
    [];
  if (Array.isArray(src)) {
    src.forEach((l) => {
      if (typeof l === "string") {
        lines.push({ minute: null, text: l, type: "log" });
      } else if (l && l.text) {
        lines.push({
          minute: l.minute != null ? l.minute : null,
          text: l.text,
          type: l.type || "log",
          payload: l.payload || {},
        });
      }
    });
  }
  // scorers as goal events
  const scorers =
    (match && match.scorers) || (state && state.scorers) || [];
  scorers.forEach((s) => {
    lines.push({
      minute: s.minute != null ? s.minute : null,
      text:
        "GOL " +
        (s.name || "?") +
        (s.assist ? " (asist: " + s.assist + ")" : ""),
      type: "goal",
      payload: s,
    });
  });
  return lines;
}

function buildEvents(scorers, logLines) {
  const events = [];
  (scorers || []).forEach((s) => {
    events.push({
      type: "goal",
      minute: s.minute,
      player: s.name,
      side: s.side,
      assist: s.assist || null,
    });
  });
  (logLines || []).forEach((l) => {
    if (l.type && l.type !== "log" && l.type !== "goal") {
      events.push({
        type: l.type,
        minute: l.minute,
        text: l.text,
      });
    }
  });
  return events;
}

/** Son maçlar (kulüp) */
async function listRecentForClub(clubId, limit) {
  const { rows } = await query(
    `SELECT id, competition, home_goals AS "homeGoals", away_goals AS "awayGoals",
            home_name AS "homeName", away_name AS "awayName",
            scorers, stats, finished_at AS "finishedAt", external_id AS "externalId",
            fixture_id AS "fixtureId"
     FROM match_results
     WHERE home_club_id = $1 OR away_club_id = $1
     ORDER BY finished_at DESC
     LIMIT $2`,
    [clubId, limit || 10],
  );
  return rows;
}

async function getMatchDetail(matchId) {
  const { rows } = await query(
    `SELECT * FROM match_results WHERE id = $1`,
    [matchId],
  );
  if (!rows[0]) return null;
  const { rows: logs } = await query(
    `SELECT minute, text, event_type AS "eventType", payload, created_at AS "createdAt"
     FROM match_logs WHERE match_id = $1 ORDER BY id ASC`,
    [matchId],
  );
  return { match: rows[0], logs };
}

/**
 * Kupa gol / asist krallığı — match_results (competition = 'cup') scorers JSON'undan.
 * Oyuncu adı + takım adı; limit varsayılan 15.
 */
async function getCupKings(opts = {}) {
  const limit = Math.min(50, Math.max(1, parseInt(opts.limit, 10) || 15));
  const { rows } = await query(
    `SELECT scorers, home_name AS "homeName", away_name AS "awayName"
     FROM match_results
     WHERE competition = 'cup'
       AND scorers IS NOT NULL
       AND jsonb_typeof(scorers) = 'array'
       AND jsonb_array_length(scorers) > 0
     ORDER BY finished_at DESC
     LIMIT 500`,
  );

  const goalMap = Object.create(null);
  const assistMap = Object.create(null);

  function bump(map, playerName, teamName, n) {
    if (!playerName || n <= 0) return;
    const key = String(playerName).trim().toLowerCase() + "|" + String(teamName || "").trim().toLowerCase();
    if (!map[key]) {
      map[key] = {
        playerName: String(playerName).trim(),
        clubName: teamName || "-",
        goals: 0,
        assists: 0,
      };
    }
    return map[key];
  }

  for (const row of rows) {
    let scorers = row.scorers;
    if (typeof scorers === "string") {
      try {
        scorers = JSON.parse(scorers);
      } catch (_) {
        continue;
      }
    }
    if (!Array.isArray(scorers)) continue;
    for (const s of scorers) {
      if (!s || !s.name) continue;
      const team =
        s.side === "away"
          ? row.awayName || s.team || "-"
          : s.side === "home"
            ? row.homeName || s.team || "-"
            : s.team || row.homeName || "-";
      const gEntry = bump(goalMap, s.name, team, 1);
      if (gEntry) gEntry.goals += 1;
      if (s.assist) {
        const aEntry = bump(assistMap, s.assist, team, 1);
        if (aEntry) aEntry.assists += 1;
      }
    }
  }

  const goalKing = Object.values(goalMap)
    .sort((a, b) => b.goals - a.goals || a.playerName.localeCompare(b.playerName))
    .slice(0, limit)
    .map((r) => ({
      playerName: r.playerName,
      clubName: r.clubName,
      goals: r.goals,
    }));

  const assistKing = Object.values(assistMap)
    .sort((a, b) => b.assists - a.assists || a.playerName.localeCompare(b.playerName))
    .slice(0, limit)
    .map((r) => ({
      playerName: r.playerName,
      clubName: r.clubName,
      assists: r.assists,
    }));

  return { goalKing, assistKing };
}

module.exports = {
  persistMatch,
  listRecentForClub,
  getMatchDetail,
  getCupKings,
};
