// ============================================================
// repos/clubsRepo.js — clubs, balance, ledger, team snapshot
// ============================================================

const { query, withTransaction } = require("../db");

async function getClub(clubId) {
  const { rows } = await query(
    `SELECT id, user_id, name, country, division, balance,
            game_style, pass_style, attack_dir, formation,
            COALESCE(is_bot, FALSE) AS is_bot
     FROM clubs WHERE id = $1`,
    [clubId],
  );
  return rows[0] || null;
}

async function getClubByUserId(userId) {
  const { rows } = await query(`SELECT * FROM clubs WHERE user_id = $1`, [
    userId,
  ]);
  return rows[0] || null;
}

async function adjustBalance(clubId, amount, label) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT balance FROM clubs WHERE id = $1 FOR UPDATE`,
      [clubId],
    );
    if (!rows[0]) return false;
    const next = Number(rows[0].balance) + Number(amount);
    if (next < 0) return false;
    await client.query(`UPDATE clubs SET balance = $1 WHERE id = $2`, [
      next,
      clubId,
    ]);
    await client.query(
      `INSERT INTO finance_ledger (club_id, amount, label) VALUES ($1, $2, $3)`,
      [clubId, amount, label || ""],
    );
    return true;
  });
}

async function getEconomy(clubId) {
  const club = await getClub(clubId);
  if (!club) return null;
  const { rows } = await query(
    `SELECT amount, label, created_at AS ts
     FROM finance_ledger WHERE club_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [clubId],
  );
  return { balance: Number(club.balance), ledger: rows };
}

function rowToPlayer(r) {
  if (!r) return null;
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
    baseQuality: r.base_quality,
    basePotential: r.base_potential,
    fromAcademy: r.from_academy,
    fromMarket: r.from_market,
    injured: r.injured,
    sentOff: r.sent_off,
    cards: r.cards,
    goals: r.goals,
    assists: r.assists,
    minutesPlayed: r.minutes_played,
  };
}

async function getTeam(clubId) {
  const club = await getClub(clubId);
  if (!club) return null;
  const { rows } = await query(
    `SELECT * FROM players WHERE club_id = $1
     ORDER BY is_starter DESC, bench_order NULLS LAST, number NULLS LAST`,
    [clubId],
  );
  const starters = rows.filter((r) => r.is_starter).map(rowToPlayer);
  const bench = rows.filter((r) => !r.is_starter).map(rowToPlayer);
  return {
    name: club.name,
    gameStyle: club.game_style,
    passStyle: club.pass_style,
    attackDir: club.attack_dir,
    currentFormation: club.formation,
    players: starters,
    bench,
  };
}

async function saveTeam(clubId, team) {
  return withTransaction(async (client) => {
    if (team.name || team.gameStyle || team.passStyle || team.attackDir) {
      await client.query(
        `UPDATE clubs SET
           name = COALESCE($2, name),
           game_style = COALESCE($3, game_style),
           pass_style = COALESCE($4, pass_style),
           attack_dir = COALESCE($5, attack_dir),
           formation = COALESCE($6, formation)
         WHERE id = $1`,
        [
          clubId,
          team.name || null,
          team.gameStyle || null,
          team.passStyle || null,
          team.attackDir || null,
          team.currentFormation || team.formation || null,
        ],
      );
    }

    const starters = team.players || [];
    const bench = team.bench || [];
    const all = [
      ...starters.map((p) => ({ p, isStarter: true, benchOrder: null })),
      ...bench.map((p, i) => ({ p, isStarter: false, benchOrder: i })),
    ];

    const { rows: existing } = await client.query(
      `SELECT id FROM players WHERE club_id = $1`,
      [clubId],
    );
    const keep = new Set(
      all.map(({ p }) => p && p.id).filter(Boolean).map(String),
    );

    for (const row of existing) {
      if (!keep.has(String(row.id))) {
        await client.query(
          `UPDATE players SET club_id = NULL, is_starter = FALSE, bench_order = NULL
           WHERE id = $1`,
          [row.id],
        );
      }
    }

    for (const { p, isStarter, benchOrder } of all) {
      if (!p) continue;
      if (p.id) {
        await client.query(
          `UPDATE players SET
             club_id = $2, name = $3, number = $4, pos = $5, natural_pos = $6,
             age = $7, pace = $8, passing = $9, finishing = $10, tackle = $11,
             vision = $12, stamina = $13, strength = $14, technique = $15,
             agility = $16, positioning = $17, reflex = $18, handling = $19,
             condition = $20, form = $21, experience = $22, happiness = $23,
             base_quality = $24, base_potential = $25,
             from_academy = $26, from_market = $27,
             is_starter = $28, bench_order = $29,
             injured = COALESCE($30, injured),
             sent_off = COALESCE($31, sent_off)
           WHERE id = $1`,
          [
            p.id, clubId, p.name, p.number || null, p.pos || "MC",
            p.naturalPos || p.pos || "MC", p.age || 18,
            p.pace ?? 10, p.passing ?? 10, p.finishing ?? 10, p.tackle ?? 10,
            p.vision ?? 10, p.stamina ?? 10, p.strength ?? 10, p.technique ?? 10,
            p.agility ?? 10, p.positioning ?? 10, p.reflex ?? 10, p.handling ?? 10,
            p.condition ?? 90, p.form ?? 0, p.experience ?? 3, p.happiness ?? 80,
            p.baseQuality ?? null, p.basePotential ?? null,
            !!p.fromAcademy, !!p.fromMarket, isStarter, benchOrder,
            p.injured != null ? !!p.injured : null,
            p.sentOff != null ? !!p.sentOff : null,
          ],
        );
      } else {
        const ins = await client.query(
          `INSERT INTO players (
             club_id, name, number, pos, natural_pos, age,
             pace, passing, finishing, tackle, vision, stamina,
             strength, technique, agility, positioning, reflex, handling,
             condition, form, experience, happiness,
             base_quality, base_potential, from_academy, from_market,
             is_starter, bench_order
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24,$25,$26,$27,$28
           ) RETURNING id`,
          [
            clubId, p.name || "Oyuncu", p.number || null, p.pos || "MC",
            p.naturalPos || p.pos || "MC", p.age || 18,
            p.pace ?? 10, p.passing ?? 10, p.finishing ?? 10, p.tackle ?? 10,
            p.vision ?? 10, p.stamina ?? 10, p.strength ?? 10, p.technique ?? 10,
            p.agility ?? 10, p.positioning ?? 10, p.reflex ?? 10, p.handling ?? 10,
            p.condition ?? 90, p.form ?? 0, p.experience ?? 3, p.happiness ?? 80,
            p.baseQuality ?? null, p.basePotential ?? null,
            !!p.fromAcademy, !!p.fromMarket, isStarter, benchOrder,
          ],
        );
        p.id = ins.rows[0].id;
      }
    }
    return true;
  });
}

async function getTeamName(clubId) {
  const { rows } = await query(`SELECT name FROM clubs WHERE id = $1`, [clubId]);
  return rows[0] ? rows[0].name : null;
}

module.exports = {
  getClub,
  getClubByUserId,
  adjustBalance,
  getEconomy,
  getTeam,
  saveTeam,
  getTeamName,
  rowToPlayer,
};
