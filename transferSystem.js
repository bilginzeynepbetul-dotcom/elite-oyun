// ============================================================
// transferSystem.js — piyasa, teklif, settle, bot teklifleri
// ============================================================

const crypto = require("crypto");
const { query, withTransaction } = require("./db");
const transferRepo = require("./repos/transferRepo");
const clubsRepo = require("./repos/clubsRepo");
const economy = require("./economyBalance");

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function playerValue(p) {
  if (typeof economy.estimatePlayerValueCalibrated === "function") {
    return economy.estimatePlayerValueCalibrated(p);
  }
  return 100000;
}

async function listMarket() {
  await settleExpired().catch(() => {});
  await maybeBotBids().catch(() => {});
  return transferRepo.loadActiveListings();
}

async function listPlayer(clubId, playerId, minPrice, hours) {
  const team = await clubsRepo.getTeam(clubId);
  if (!team) return { ok: false, error: "Kulüp yok" };
  const all = [...(team.players || []), ...(team.bench || [])];
  const player = all.find((p) => p && String(p.id) === String(playerId));
  if (!player) return { ok: false, error: "Oyuncu bulunamadı" };
  if ((team.players || []).filter((p) => p && !p.injured).length <= 11 &&
      (team.players || []).some((p) => p && String(p.id) === String(playerId))) {
    return { ok: false, error: "İlk 11'den ilan için yeterli kadro yok" };
  }

  const club = await clubsRepo.getClub(clubId);
  const value = playerValue(player);
  const start = Math.max(
    Math.floor(value * 0.4),
    Number(minPrice) || Math.floor(value * 0.5),
  );
  const durH = Math.max(1, Math.min(72, Number(hours) || 24));
  const endsAt = Date.now() + durH * 3600 * 1000;
  const id = newId();

  const listing = {
    id,
    player: {
      id: player.id,
      name: player.name,
      pos: player.pos,
      age: player.age,
      pace: player.pace,
      passing: player.passing,
      finishing: player.finishing,
      tackle: player.tackle,
      vision: player.vision,
      stamina: player.stamina,
      strength: player.strength,
      technique: player.technique,
      value,
    },
    sellerClubId: clubId,
    clubName: (club && club.name) || "Kulüp",
    auctionStart: start,
    currentBid: start,
    highestBidderClubId: null,
    highestBidderName: null,
    auctionEndsAt: endsAt,
    status: "active",
  };

  await transferRepo.upsertListing(listing);
  // Oyuncuyu satıcı kadrosundan çıkarma — settle'da yapılır (rezervasyon)
  return { ok: true, listing };
}

async function placeBid(clubId, listingId, amount) {
  const listings = await transferRepo.loadActiveListings();
  const L = listings.find((x) => String(x.id) === String(listingId));
  if (!L) return { ok: false, error: "İlan yok veya süresi dolmuş" };
  if (String(L.sellerClubId) === String(clubId)) {
    return { ok: false, error: "Kendi ilanına teklif veremezsin" };
  }
  const club = await clubsRepo.getClub(clubId);
  if (!club) return { ok: false, error: "Kulüp yok" };

  // Anti-cheat: tavan / taban / bakiye
  const v = antiCheat.validateBidAmount(amount, club.balance);
  if (!v.ok) return v;
  const bid = v.amount;

  const minNext = Math.floor(L.currentBid * 1.05) || L.auctionStart;
  if (bid < minNext) {
    return { ok: false, error: "Minimum teklif " + minNext };
  }

  // Anti-snipe: son 2 dk → +2 dk
  let endsAt = L.auctionEndsAt;
  if (endsAt - Date.now() < 2 * 60 * 1000) {
    endsAt = Date.now() + 2 * 60 * 1000;
  }

  await transferRepo.insertBid(
    listingId,
    clubId,
    club.name || "Kulüp",
    bid,
  );
  L.currentBid = bid;
  L.highestBidderClubId = clubId;
  L.highestBidderName = club.name;
  L.auctionEndsAt = endsAt;
  await transferRepo.upsertListing(L);

  try {
    const { rows } = await query(`SELECT user_id FROM clubs WHERE id = $1`, [clubId]);
    const uid = rows[0] && rows[0].user_id;
    if (uid) {
      try { await require("./dailyChallengeSystem").onTransferBid(uid); } catch (_) {}
    }
  } catch (_) {}

  return { ok: true, listing: L };
}

async function cancelListing(clubId, listingId) {
  const listings = await transferRepo.loadActiveListings();
  const L = listings.find((x) => String(x.id) === String(listingId));
  if (!L) return { ok: false, error: "İlan yok" };
  if (String(L.sellerClubId) !== String(clubId)) {
    return { ok: false, error: "Bu ilan sana ait değil" };
  }
  if (L.highestBidderClubId) {
    return { ok: false, error: "Teklif varken iptal edilemez" };
  }
  await transferRepo.setListingStatus(listingId, "cancelled");
  return { ok: true };
}

async function settleExpired() {
  const { rows } = await query(
    `SELECT id FROM transfer_listings
     WHERE status = 'active' AND auction_ends_at <= NOW()
     LIMIT 30`,
  );
  for (const row of rows) {
    try {
      await settleOne(row.id);
    } catch (e) {
      console.warn("[transfer] settle", row.id, e.message);
    }
  }
}

async function settleOne(listingId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM transfer_listings WHERE id = $1 FOR UPDATE`,
      [listingId],
    );
    const L = rows[0];
    if (!L || L.status !== "active") return { ok: false };
    if (new Date(L.auction_ends_at) > new Date()) return { ok: false };

    const buyerId = L.highest_bidder_club_id;
    const amount = Number(L.current_bid) || 0;
    const sellerId = L.seller_club_id;
    const playerId = L.player_id;
    const snap = L.player_snapshot || {};

    if (!buyerId || amount <= 0) {
      await client.query(
        `UPDATE transfer_listings SET status = 'expired' WHERE id = $1`,
        [listingId],
      );
      return { ok: true, result: "expired" };
    }

    // Alıcı bot mu?
    const { rows: buyerRows } = await client.query(
      `SELECT id, user_id, is_bot, balance, name FROM clubs WHERE id = $1 FOR UPDATE`,
      [buyerId],
    );
    const buyer = buyerRows[0];
    const isBotBuyer = buyer && (buyer.is_bot || !buyer.user_id);

    if (isBotBuyer) {
      // Bot kazandı: satıcıya ödeme, oyuncu piyasadan çıkar (bot kadrosuna eklenmez)
      if (sellerId) {
        await client.query(
          `UPDATE clubs SET balance = balance + $2 WHERE id = $1`,
          [sellerId, amount],
        );
        await client.query(
          `INSERT INTO finance_ledger (club_id, amount, label) VALUES ($1, $2, $3)`,
          [sellerId, amount, "Transfer satışı (bot alıcı)"],
        );
      }
      if (playerId) {
        await client.query(
          `UPDATE players SET club_id = NULL, is_starter = FALSE WHERE id = $1`,
          [playerId],
        );
      }
      await client.query(
        `UPDATE transfer_listings SET status = 'sold' WHERE id = $1`,
        [listingId],
      );
      return { ok: true, result: "sold_to_bot" };
    }

    // İnsan alıcı
    if (!buyer || Number(buyer.balance) < amount) {
      await client.query(
        `UPDATE transfer_listings SET status = 'expired' WHERE id = $1`,
        [listingId],
      );
      return { ok: true, result: "buyer_broke" };
    }

    await client.query(
      `UPDATE clubs SET balance = balance - $2 WHERE id = $1`,
      [buyerId, amount],
    );
    await client.query(
      `INSERT INTO finance_ledger (club_id, amount, label) VALUES ($1, $2, $3)`,
      [buyerId, -amount, "Transfer alımı: " + (snap.name || "")],
    );
    if (sellerId) {
      await client.query(
        `UPDATE clubs SET balance = balance + $2 WHERE id = $1`,
        [sellerId, amount],
      );
      await client.query(
        `INSERT INTO finance_ledger (club_id, amount, label) VALUES ($1, $2, $3)`,
        [sellerId, amount, "Transfer satışı: " + (snap.name || "")],
      );
    }
    if (playerId) {
      await client.query(
        `UPDATE players SET club_id = $2, is_starter = FALSE, bench_order = 99
         WHERE id = $1`,
        [playerId, buyerId],
      );
    }
    await client.query(
      `UPDATE transfer_listings SET status = 'sold' WHERE id = $1`,
      [listingId],
    );

    // Achievements outside tx best-effort
    setImmediate(async () => {
      try {
        const ach = require("./achievementsSystem");
const antiCheat = require("./antiCheat");
        if (buyerId) {
          const { rows: br } = await query(
            `SELECT user_id FROM clubs WHERE id = $1`, [buyerId],
          );
          if (br[0] && br[0].user_id) await ach.onTransferBuy(br[0].user_id);
        }
        if (sellerId) {
          const { rows: sr } = await query(
            `SELECT user_id FROM clubs WHERE id = $1`, [sellerId],
          );
          if (sr[0] && sr[0].user_id) await ach.onTransferSell(sr[0].user_id);
        }
      } catch (_) {}
    });

    return { ok: true, result: "sold" };
  });
}

/** Bot teklifleri (TRANSFER_BOT.md) */
async function maybeBotBids() {
  const listings = await transferRepo.loadActiveListings();
  if (!listings.length) return;

  const { rows: bots } = await query(
    `SELECT id, name FROM clubs WHERE COALESCE(is_bot, FALSE) = TRUE LIMIT 40`,
  );
  if (!bots.length) return;

  for (const L of listings) {
    const remaining = L.auctionEndsAt - Date.now();
    if (remaining <= 0) continue;

    const sellerIsHuman = await isHumanClub(L.sellerClubId);
    let chance = sellerIsHuman ? 0.35 : 0.18;
    if (remaining < 5 * 60 * 1000) chance *= 1.8;
    else if (remaining < 30 * 60 * 1000) chance *= 1.35;

    // Bot zaten liderse seyrek
    if (L.highestBidderClubId) {
      const leaderBot = bots.some(
        (b) => String(b.id) === String(L.highestBidderClubId),
      );
      if (leaderBot) chance *= 0.25;
    }

    if (Math.random() > chance) continue;

    const value = (L.player && L.player.value) || L.auctionStart * 1.5;
    const cap = Math.floor(value * 1.28);
    if (L.currentBid >= cap) continue;

    const step = Math.max(
      1000,
      Math.floor(L.currentBid * (0.03 + Math.random() * 0.05)),
    );
    const bid = Math.min(cap, L.currentBid + step);
    const bot = bots[Math.floor(Math.random() * bots.length)];
    if (String(bot.id) === String(L.sellerClubId)) continue;
    if (String(bot.id) === String(L.highestBidderClubId)) continue;

    try {
      let endsAt = L.auctionEndsAt;
      if (endsAt - Date.now() < 2 * 60 * 1000) {
        endsAt = Date.now() + 2 * 60 * 1000;
      }
      await transferRepo.insertBid(L.id, bot.id, bot.name, bid);
      L.currentBid = bid;
      L.highestBidderClubId = bot.id;
      L.highestBidderName = bot.name;
      L.auctionEndsAt = endsAt;
      await transferRepo.upsertListing(L);
    } catch (e) {
      /* ignore */
    }
  }
}

async function isHumanClub(clubId) {
  if (!clubId) return false;
  const { rows } = await query(
    `SELECT user_id, COALESCE(is_bot, FALSE) AS is_bot FROM clubs WHERE id = $1`,
    [clubId],
  );
  return rows[0] && rows[0].user_id && !rows[0].is_bot;
}

// Periyodik settle
let settleTimer = null;
function startTransferLoop() {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    settleExpired().catch((e) =>
      console.warn("[transfer] settle loop", e.message),
    );
    maybeBotBids().catch(() => {});
  }, 30000);
}

module.exports = {
  listMarket,
  listPlayer,
  placeBid,
  cancelListing,
  settleExpired,
  maybeBotBids,
  startTransferLoop,
  playerValue,
};
