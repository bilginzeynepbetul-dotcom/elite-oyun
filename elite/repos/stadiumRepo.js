const { query } = require("../db");

async function getStadiumState(clubId) {
  const { rows } = await query(
    `SELECT name, capacity, ticket_price, seat_upgrade_cost, total_upgrades
     FROM stadiums WHERE club_id = $1`,
    [clubId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    name: r.name,
    capacity: r.capacity,
    ticketPrice: r.ticket_price,
    seatUpgradeCost: r.seat_upgrade_cost,
    totalUpgrades: r.total_upgrades,
  };
}

async function saveStadiumState(clubId, s) {
  await query(
    `INSERT INTO stadiums (club_id, name, capacity, ticket_price, seat_upgrade_cost, total_upgrades)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (club_id) DO UPDATE SET
       name = EXCLUDED.name,
       capacity = EXCLUDED.capacity,
       ticket_price = EXCLUDED.ticket_price,
       seat_upgrade_cost = EXCLUDED.seat_upgrade_cost,
       total_upgrades = EXCLUDED.total_upgrades,
       updated_at = NOW()`,
    [
      clubId,
      s.name || "Arena",
      s.capacity || 24500,
      s.ticketPrice || 12,
      s.seatUpgradeCost || 45000,
      s.totalUpgrades || 0,
    ],
  );
}

module.exports = { getStadiumState, saveStadiumState };
