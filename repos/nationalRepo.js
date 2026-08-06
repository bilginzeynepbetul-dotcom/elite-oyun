// ============================================================
// repos/nationalRepo.js — Milli takım: kadro, çağrı, fikstür
// ============================================================

const { query, withTransaction } = require("../db");

const MAX_SQUAD = 23;

function rowToTeam(r) {
  if (!r) return null;
  return {
    id: r.id,
    country: r.country,
    category: r.category || "A",
    managerUserId: r.manager_user_id,
    managerClubId: r.manager_club_id,
    managerSince: r.manager_since,
    formation: r.formation,
    gameStyle: r.game_style,
    passStyle: r.pass_style,
  };
}

function normCategory(cat) {
  const c = String(cat || "A").toUpperCase();
  return c === "U21" ? "U21" : "A";
}

async function getTeamByCountry(country, category) {
  const cat = normCategory(category);
  const { rows } = await query(
    `SELECT * FROM national_teams WHERE country = $1 AND category = $2`,
    [country, cat],
  );
  return rowToTeam(rows[0]);
}

/** category kolonu yoksa (migrate öncesi) country ile tek satır dene */
async function getTeamByCountryFallback(country, category) {
  try {
    return await getTeamByCountry(country, category);
  } catch (e) {
    const { rows } = await query(`SELECT * FROM national_teams WHERE country = $1`, [country]);
    return rowToTeam(rows[0]);
  }
}

async function getTeamById(id) {
  const { rows } = await query(`SELECT * FROM national_teams WHERE id = $1`, [id]);
  return rowToTeam(rows[0]);
}

/** Boşsa TD koltuğunu alır. Atomik: satırı kilitleyip tekrar kontrol eder. */
async function claimManager(nationalTeamId, userId, clubId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT manager_user_id FROM national_teams WHERE id = $1 FOR UPDATE`,
      [nationalTeamId],
    );
    if (!rows[0]) return { ok: false, error: "Milli takım bulunamadı" };
    if (rows[0].manager_user_id) {
      return { ok: false, error: "Bu koltuk zaten dolu" };
    }
    await client.query(
      `UPDATE national_teams SET manager_user_id = $2, manager_club_id = $3,
         manager_since = NOW(), updated_at = NOW() WHERE id = $1`,
      [nationalTeamId, userId, clubId],
    );
    return { ok: true };
  });
}

// ---------------- TD başvuru / atama ----------------
async function applyForManager(nationalTeamId, userId, clubId, message) {
  try {
    const { rows } = await query(
      `INSERT INTO national_manager_applications (national_team_id, user_id, club_id, message)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [nationalTeamId, userId, clubId, message || null],
    );
    return { ok: true, applicationId: rows[0].id };
  } catch (e) {
    if (e.code === "23505") {
      return { ok: false, error: "Zaten bekleyen bir başvurun var" };
    }
    throw e;
  }
}

async function withdrawApplication(nationalTeamId, userId) {
  await query(
    `UPDATE national_manager_applications SET status = 'withdrawn', decided_at = NOW()
     WHERE national_team_id = $1 AND user_id = $2 AND status = 'pending'`,
    [nationalTeamId, userId],
  );
  return { ok: true };
}

async function getMyApplication(nationalTeamId, userId) {
  const { rows } = await query(
    `SELECT id, status, created_at FROM national_manager_applications
     WHERE national_team_id = $1 AND user_id = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [nationalTeamId, userId],
  );
  return rows[0] ? { id: rows[0].id, status: rows[0].status, createdAt: rows[0].created_at } : null;
}

async function listApplications(nationalTeamId, status = "pending") {
  const { rows } = await query(
    `SELECT a.id, a.user_id, a.club_id, a.message, a.status, a.created_at,
       u.username, c.name AS club_name
     FROM national_manager_applications a
     JOIN users u ON u.id = a.user_id
     LEFT JOIN clubs c ON c.id = a.club_id
     WHERE a.national_team_id = $1 AND a.status = $2
     ORDER BY a.created_at ASC`,
    [nationalTeamId, status],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    clubId: r.club_id,
    clubName: r.club_name,
    username: r.username,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** Admin bir başvuruyu onaylar: başvuran TD olur, aynı takımın diğer bekleyen
 *  başvuruları reddedilir, kadro sıfırlanır (yeni TD temiz başlasın). */
async function appointFromApplication(nationalTeamId, applicationId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM national_manager_applications
       WHERE id = $1 AND national_team_id = $2 AND status = 'pending' FOR UPDATE`,
      [applicationId, nationalTeamId],
    );
    const app = rows[0];
    if (!app) return { ok: false, error: "Başvuru bulunamadı ya da zaten karara bağlanmış" };

    await client.query(
      `UPDATE national_teams SET manager_user_id = $2, manager_club_id = $3,
         manager_since = NOW(), updated_at = NOW() WHERE id = $1`,
      [nationalTeamId, app.user_id, app.club_id],
    );
    await client.query(`DELETE FROM national_squad WHERE national_team_id = $1`, [nationalTeamId]);
    await client.query(
      `UPDATE national_manager_applications SET status = 'approved', decided_at = NOW() WHERE id = $1`,
      [applicationId],
    );
    await client.query(
      `UPDATE national_manager_applications SET status = 'rejected', decided_at = NOW()
       WHERE national_team_id = $1 AND status = 'pending' AND id != $2`,
      [nationalTeamId, applicationId],
    );
    return { ok: true, userId: app.user_id, clubId: app.club_id };
  });
}

/** Sadece mevcut TD bırakabilir. Bırakınca kadro sıfırlanır (yeni TD temiz başlasın). */
async function resignManager(nationalTeamId, userId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT manager_user_id FROM national_teams WHERE id = $1 FOR UPDATE`,
      [nationalTeamId],
    );
    if (!rows[0]) return { ok: false, error: "Milli takım bulunamadı" };
    if (rows[0].manager_user_id !== userId) {
      return { ok: false, error: "Teknik direktör sen değilsin" };
    }
    await client.query(
      `UPDATE national_teams SET manager_user_id = NULL, manager_club_id = NULL,
         manager_since = NULL, updated_at = NOW() WHERE id = $1`,
      [nationalTeamId],
    );
    await client.query(`DELETE FROM national_squad WHERE national_team_id = $1`, [
      nationalTeamId,
    ]);
    return { ok: true };
  });
}

/** Ülkenin kulüplerindeki adaylar. maxAge verilirse (U21 → 21) yaş filtresi. */
async function listCandidates(country, nationalTeamId, maxAge) {
  const params = [country, nationalTeamId];
  let ageClause = "";
  if (maxAge != null && Number(maxAge) > 0) {
    params.push(Number(maxAge));
    ageClause = ` AND p.age <= $${params.length}`;
  }
  const { rows } = await query(
    `SELECT p.id, p.name, p.pos, p.age, p.club_id, c.name AS club_name,
       ROUND((p.pace + p.passing + p.finishing + p.tackle + p.vision +
              p.stamina + p.strength + p.technique + p.agility + p.positioning
             ) / 10.0) AS overall,
       EXISTS(
         SELECT 1 FROM national_squad ns
         WHERE ns.national_team_id = $2 AND ns.player_id = p.id
       ) AS called
     FROM players p
     JOIN clubs c ON c.id = p.club_id
     WHERE c.country = $1 AND p.club_id IS NOT NULL` + ageClause + `
     ORDER BY overall DESC`,
    params,
  );
  return rows.map((r) => ({
    playerId: r.id,
    name: r.name,
    pos: r.pos,
    age: r.age,
    clubId: r.club_id,
    clubName: r.club_name,
    overall: Number(r.overall),
    called: r.called,
  }));
}

async function getSquad(nationalTeamId) {
  const { rows } = await query(
    `SELECT ns.player_id, ns.is_starter, ns.bench_order, ns.called_up_at, ns.pos AS assigned_pos,
       p.name, p.pos AS natural_pos, p.age, p.club_id, c.name AS club_name,
       ROUND((p.pace + p.passing + p.finishing + p.tackle + p.vision +
              p.stamina + p.strength + p.technique + p.agility + p.positioning
             ) / 10.0) AS overall
     FROM national_squad ns
     JOIN players p ON p.id = ns.player_id
     LEFT JOIN clubs c ON c.id = p.club_id
     WHERE ns.national_team_id = $1
     ORDER BY ns.is_starter DESC, ns.bench_order NULLS LAST, overall DESC`,
    [nationalTeamId],
  );
  return rows.map((r) => ({
    playerId: r.player_id,
    name: r.name,
    pos: r.assigned_pos || r.natural_pos,
    naturalPos: r.natural_pos,
    age: r.age,
    clubId: r.club_id,
    clubName: r.club_name,
    overall: Number(r.overall),
    isStarter: r.is_starter,
  }));
}

async function squadCount(nationalTeamId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM national_squad WHERE national_team_id = $1`,
    [nationalTeamId],
  );
  return rows[0].c;
}

async function callUpPlayer(nationalTeamId, playerId, clubId) {
  const count = await squadCount(nationalTeamId);
  if (count >= MAX_SQUAD) {
    return { ok: false, error: "Kadro dolu (23 oyuncu)" };
  }
  try {
    await query(
      `INSERT INTO national_squad (national_team_id, player_id, club_id, is_starter)
       VALUES ($1, $2, $3, FALSE)`,
      [nationalTeamId, playerId, clubId],
    );
    return { ok: true };
  } catch (e) {
    if (e.code === "23505") return { ok: false, error: "Oyuncu zaten kadroda" };
    throw e;
  }
}

async function dropPlayer(nationalTeamId, playerId) {
  await query(
    `DELETE FROM national_squad WHERE national_team_id = $1 AND player_id = $2`,
    [nationalTeamId, playerId],
  );
  return { ok: true };
}

/**
 * İlk 11'i belirler (kadroda olmayan id'ler yok sayılır), formasyonu ve
 * (varsa) her oyuncunun saha üstü mevkisini + pas stilini kaydeder.
 * assignments: [{ playerId, pos }] — pos verilmezse oyuncunun doğal mevkisi kullanılır.
 */
async function setLineup(nationalTeamId, starterPlayerIds, formation, assignments, passStyle, gameStyle) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE national_squad SET is_starter = FALSE WHERE national_team_id = $1`,
      [nationalTeamId],
    );
    const ids = (starterPlayerIds || []).slice(0, 11);
    const posByPlayer = new Map(
      (assignments || []).map((a) => [a.playerId, a.pos || null]),
    );
    for (const pid of ids) {
      await client.query(
        `UPDATE national_squad SET is_starter = TRUE, pos = $3
         WHERE national_team_id = $1 AND player_id = $2`,
        [nationalTeamId, pid, posByPlayer.get(pid) || null],
      );
    }
    if (formation || passStyle || gameStyle) {
      await client.query(
        `UPDATE national_teams SET
           formation = COALESCE($2, formation),
           pass_style = COALESCE($3, pass_style),
           game_style = COALESCE($4, game_style),
           updated_at = NOW()
         WHERE id = $1`,
        [nationalTeamId, formation || null, passStyle || null, gameStyle || null],
      );
    }
    return { ok: true };
  });
}

function rowToMatchPlayer(r) {
  return {
    id: r.id,
    name: r.name,
    number: r.number,
    pos: r.pos,
    naturalPos: r.natural_pos || r.pos,
    age: r.age,
    pace: Number(r.pace),
    passing: Number(r.passing),
    finishing: Number(r.finishing),
    tackle: Number(r.tackle),
    vision: Number(r.vision),
    stamina: Number(r.stamina),
    strength: Number(r.strength),
    technique: Number(r.technique),
    agility: Number(r.agility),
    positioning: Number(r.positioning),
    reflex: Number(r.reflex),
    handling: Number(r.handling),
    condition: Number(r.condition),
    form: Number(r.form),
    experience: Number(r.experience),
    happiness: Number(r.happiness),
  };
}

/** Maç motoruna verilecek şekilde: { players (starters), bench }. */
async function getSquadForMatch(nationalTeamId) {
  const { rows } = await query(
    `SELECT p.*, ns.is_starter, ns.bench_order, COALESCE(ns.pos, p.pos) AS pos
     FROM national_squad ns
     JOIN players p ON p.id = ns.player_id
     WHERE ns.national_team_id = $1
     ORDER BY ns.is_starter DESC, ns.bench_order NULLS LAST`,
    [nationalTeamId],
  );
  const starters = rows.filter((r) => r.is_starter).map(rowToMatchPlayer);
  const bench = rows.filter((r) => !r.is_starter).map(rowToMatchPlayer);
  return { starters, bench };
}

// ---------------- fixtures ----------------

async function getUpcomingFixture(nationalTeamId) {
  const { rows } = await query(
    `SELECT * FROM national_fixtures
     WHERE national_team_id = $1 AND status IN ('scheduled', 'live')
     ORDER BY kickoff_at ASC LIMIT 1`,
    [nationalTeamId],
  );
  return rowToFixture(rows[0]);
}

async function listRecentFixtures(nationalTeamId, limit = 5) {
  const { rows } = await query(
    `SELECT * FROM national_fixtures
     WHERE national_team_id = $1 AND status = 'finished'
     ORDER BY kickoff_at DESC LIMIT $2`,
    [nationalTeamId, limit],
  );
  return rows.map(rowToFixture);
}

function rowToFixture(r) {
  if (!r) return null;
  return {
    id: r.id,
    nationalTeamId: r.national_team_id,
    opponentName: r.opponent_name,
    opponentStrength: r.opponent_strength,
    kickoffAt: r.kickoff_at,
    status: r.status,
    homeGoals: r.home_goals,
    awayGoals: r.away_goals,
    matchId: r.match_id,
  };
}

async function createFixture(nationalTeamId, opponentName, opponentStrength, kickoffAt) {
  const { rows } = await query(
    `INSERT INTO national_fixtures (national_team_id, opponent_name, opponent_strength, kickoff_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [nationalTeamId, opponentName, opponentStrength, kickoffAt],
  );
  return rowToFixture(rows[0]);
}

async function getFixtureById(id) {
  const { rows } = await query(`SELECT * FROM national_fixtures WHERE id = $1`, [id]);
  return rowToFixture(rows[0]);
}

async function listDueFixtures(limit = 10) {
  const { rows } = await query(
    `SELECT * FROM national_fixtures
     WHERE status = 'scheduled' AND kickoff_at <= NOW()
     ORDER BY kickoff_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToFixture);
}

async function setFixtureLive(fixtureId, matchId) {
  await query(
    `UPDATE national_fixtures SET status = 'live', match_id = COALESCE($2, match_id)
     WHERE id = $1`,
    [fixtureId, matchId],
  );
}

async function finishFixture(fixtureId, homeGoals, awayGoals) {
  await query(
    `UPDATE national_fixtures
     SET status = 'finished', home_goals = $2, away_goals = $3
     WHERE id = $1`,
    [fixtureId, homeGoals, awayGoals],
  );
}

module.exports = {
  MAX_SQUAD,
  getTeamByCountry,
  normCategory,
  getTeamById,
  claimManager,
  resignManager,
  applyForManager,
  withdrawApplication,
  getMyApplication,
  listApplications,
  appointFromApplication,
  listCandidates,
  getSquad,
  getSquadForMatch,
  squadCount,
  callUpPlayer,
  dropPlayer,
  setLineup,
  getUpcomingFixture,
  listRecentFixtures,
  createFixture,
  getFixtureById,
  listDueFixtures,
  setFixtureLive,
  finishFixture,
};
