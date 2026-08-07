// ============================================================
// repos/transferRepo.js — transfer listings + bids persistence
// ============================================================

const { query, withTransaction } = require("../db");

function rowToListing(r) {
  const snap = r.player_snapshot || {};
  return {
    id: r.id,
    player: snap,
    clubName: r.club_name_snapshot,
    sellerClubId: r.seller_club_id,
    auctionStart: Number(r.auction_start),
    currentBid: Number(r.current_bid),
    highestBidderClubId: r.highest_bidder_club_id,
    highestBidderName: r.highest_bidder_name,
    auctionEndsAt: new Date(r.auction_ends_at).getTime(),
    bidHistory: r.bid_history || [],
    createdAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
    status: r.status,
  };
}

async function loadActiveListings() {
  const { rows } = await query(
    `SELECT id, player_id, seller_club_id, club_name_snapshot, player_snapshot,
            auction_start, current_bid, highest_bidder_club_id, highest_bidder_name,
            auction_ends_at, status, created_at,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'clubId', b.club_id,
                 'clubName', b.club_name,
                 'amount', b.amount,
                 'at', EXTRACT(EPOCH FROM b.created_at)*1000
               ) ORDER BY b.created_at)
               FROM transfer_bids b WHERE b.listing_id = tl.id),
              '[]'::json
            ) AS bid_history
     FROM transfer_listings tl
     WHERE status = 'active'
     ORDER BY auction_ends_at ASC`,
  );
  return rows.map(rowToListing);
}

async function upsertListing(L) {
  if (!L || !L.id) return;
  await query(
    `INSERT INTO transfer_listings (
       id, player_id, seller_club_id, club_name_snapshot, player_snapshot,
       auction_start, current_bid, highest_bidder_club_id, highest_bidder_name,
       auction_ends_at, status
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb,
       $6, $7, $8, $9,
       to_timestamp($10::bigint/1000.0), 'active'
     )
     ON CONFLICT (id) DO UPDATE SET
       current_bid = EXCLUDED.current_bid,
       highest_bidder_club_id = EXCLUDED.highest_bidder_club_id,
       highest_bidder_name = EXCLUDED.highest_bidder_name,
       auction_ends_at = EXCLUDED.auction_ends_at,
       status = EXCLUDED.status,
       player_snapshot = EXCLUDED.player_snapshot`,
    [
      L.id,
      L.player && L.player.id ? L.player.id : null,
      L.sellerClubId || null,
      L.clubName || "?",
      JSON.stringify(L.player || {}),
      L.auctionStart || L.currentBid || 0,
      L.currentBid || 0,
      L.highestBidderClubId || null,
      L.highestBidderName || null,
      L.auctionEndsAt || Date.now() + 86400000,
    ],
  );
}

async function insertBid(listingId, clubId, clubName, amount) {
  await query(
    `INSERT INTO transfer_bids (listing_id, club_id, club_name, amount)
     VALUES ($1, $2, $3, $4)`,
    [listingId, clubId, clubName || "?", amount],
  );
}

async function setListingStatus(listingId, status) {
  await query(
    `UPDATE transfer_listings SET status = $2 WHERE id = $1`,
    [listingId, status],
  );
}

async function deleteListingRow(listingId) {
  // Soft: mark expired/cancelled; bids cascade on hard delete
  await query(`DELETE FROM transfer_listings WHERE id = $1`, [listingId]);
}

module.exports = {
  loadActiveListings,
  upsertListing,
  insertBid,
  setListingStatus,
  deleteListingRow,
};
