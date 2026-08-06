// ============================================================
// transferSystem.js — SUNUCU TARAFLI TRANSFER / AÇIK ARTIRMA
// ------------------------------------------------------------
// Bellek içi depo; kalıcılık için save/load kancaları bırakıldı.
// API katmanı (Express) bu modülü çağırır — bkz. transferRoutes.js
// ============================================================

const crypto = require("crypto");

/** @type {Map<string, object>} listingId → listing */
const listings = new Map();

/** Dış bağımlılıklar (server bootstrap'ta inject edilir) */
let deps = {
  /** (clubId) => { balance, name, ... } */
  getClub: null,
  /** (clubId, amount, label) => boolean — bütçe düş/art, ledger yaz */
  adjustBalance: null,
  /** (clubId) => { players, bench, name } */
  getTeam: null,
  /** (clubId, team) => void */
  saveTeam: null,
  /** (clubId) => userId|null */
  getUserIdForClub: null,
  /** optional persistence hooks (async ok, fire-and-forget) */
  persistListing: null,   // (L) => Promise
  persistBid: null,       // (listingId, clubId, clubName, amount) => Promise
  removeListing: null,    // (id, status) => Promise
  log: console.log,
};

function _persist(L) {
  if (typeof deps.persistListing === "function" && L) {
    Promise.resolve(deps.persistListing(L)).catch((e) =>
      console.error("[transfer] persistListing", e.message),
    );
  }
}
function _persistBid(listingId, clubId, clubName, amount) {
  if (typeof deps.persistBid === "function") {
    Promise.resolve(deps.persistBid(listingId, clubId, clubName, amount)).catch(
      (e) => console.error("[transfer] persistBid", e.message),
    );
  }
}
function _remove(id, status) {
  if (typeof deps.removeListing === "function") {
    Promise.resolve(deps.removeListing(id, status || "expired")).catch((e) =>
      console.error("[transfer] removeListing", e.message),
    );
  }
}

/** deps async|sync ortak çağrı */
async function _call(fn, ...args) {
  if (typeof fn !== "function") return undefined;
  return await Promise.resolve(fn(...args));
}



function configure(next) {
  deps = Object.assign(deps, next || {});
}

function uid(prefix) {
  return (
    (prefix || "t") +
    "_" +
    crypto.randomBytes(6).toString("hex") +
    "_" +
    Date.now().toString(36)
  );
}

function estimatePlayerValue(p) {
  const skills = [
    "pace",
    "passing",
    "finishing",
    "tackle",
    "vision",
    "stamina",
    "strength",
    "technique",
    "agility",
    "positioning",
    "reflex",
  ];
  const avg =
    skills.reduce((s, k) => s + (Number(p[k]) || 10), 0) / skills.length;
  const age = p.age || 25;
  let v = 50000 + avg * 90000;
  if (age <= 21) v *= 1.35;
  else if (age <= 24) v *= 1.15;
  else if (age >= 30) v *= 0.7;
  else if (age >= 33) v *= 0.45;
  return Math.round(v / 1000) * 1000;
}

function generateAiPlayer() {
  const first = [
    "Can",
    "Emre",
    "Burak",
    "Arda",
    "Kerem",
    "Yusuf",
    "Mert",
    "Ozan",
    "Hakan",
    "Cenk",
    "Berkay",
    "Tolga",
  ];
  const last = [
    "Yılmaz",
    "Demir",
    "Kaya",
    "Çelik",
    "Şahin",
    "Aydın",
    "Öztürk",
    "Arslan",
    "Doğan",
    "Kılıç",
  ];
  const positions = [
    "GK",
    "DL",
    "DC",
    "DR",
    "DM",
    "MC",
    "ML",
    "MR",
    "OMC",
    "FL",
    "FC",
    "FR",
  ];
  const clubs = [
    "Anadolu SK",
    "Ege United",
    "Karadeniz FC",
    "Boğaz SK",
    "Akdenizspor",
    "İç Anadolu FK",
    "Trakya FC",
    "Marmara SK",
  ];
  const pos = positions[Math.floor(Math.random() * positions.length)];
  const skill = () => 8 + Math.floor(Math.random() * 8);
  const p = {
    id: uid("pl"),
    name:
      first[Math.floor(Math.random() * first.length)] +
      " " +
      last[Math.floor(Math.random() * last.length)],
    pos,
    naturalPos: pos,
    age: 18 + Math.floor(Math.random() * 12),
    number: 1 + Math.floor(Math.random() * 99),
    pace: skill(),
    passing: skill(),
    finishing: skill(),
    tackle: skill(),
    vision: skill(),
    stamina: skill(),
    strength: skill(),
    technique: skill(),
    agility: skill(),
    positioning: skill(),
    reflex: skill(),
    handling: skill(),
    condition: 85 + Math.floor(Math.random() * 15),
    form: 0,
    experience: 2 + Math.floor(Math.random() * 6),
    happiness: 70 + Math.floor(Math.random() * 25),
    fromMarket: true,
    fromAcademy: false,
  };
  p.marketValue = estimatePlayerValue(p);
  return p;
}

function publicListing(L, viewerClubId) {
  return {
    id: L.id,
    player: L.player,
    clubName: L.clubName,
    sellerClubId: L.sellerClubId,
    listedByUser: !!L.sellerClubId,
    isMine: !!(viewerClubId && L.sellerClubId === viewerClubId),
    auctionStart: L.auctionStart,
    currentBid: L.currentBid,
    highestBidderClubId: L.highestBidderClubId,
    highestBidderName: L.highestBidderName,
    iAmHighest: !!(
      viewerClubId && L.highestBidderClubId === viewerClubId
    ),
    auctionEndsAt: L.auctionEndsAt,
    bidCount: (L.bidHistory || []).length,
  };
}

function seedAiListings(count) {
  count = count || 8;
  let added = 0;
  for (let i = 0; i < count; i++) {
    const player = generateAiPlayer();
    const open = player.marketValue;
    const hours = 24 + Math.floor(Math.random() * 24);
    const L = {
      id: uid("lst"),
      player,
      clubName: [
        "Anadolu SK",
        "Ege United",
        "Karadeniz FC",
        "Boğaz SK",
        "Akdenizspor",
        "Trakya FC",
      ][Math.floor(Math.random() * 6)],
      sellerClubId: null, // AI
      auctionStart: open,
      currentBid: open,
      highestBidderClubId: null,
      highestBidderName: null,
      auctionEndsAt: Date.now() + hours * 3600 * 1000,
      bidHistory: [],
      createdAt: Date.now(),
    };
    listings.set(L.id, L);
    _persist(L);
    added++;
  }
  return added;
}

function ensureSeeded() {
  if (listings.size === 0) seedAiListings(10);
}

/** GET market */
async function listMarket(viewerClubId, posFamilyFilter) {
  ensureSeeded();
  await settleExpired();
  const famMap = {
    GK: ["GK"],
    DF: ["DL", "DR", "DC", "DC2", "SW"],
    MF: ["DM", "ML", "MR", "MC", "MC2", "OMC"],
    FW: ["FL", "FR", "FC"],
  };
  let rows = Array.from(listings.values());
  if (posFamilyFilter && famMap[posFamilyFilter]) {
    const allow = new Set(famMap[posFamilyFilter]);
    rows = rows.filter((L) => allow.has(L.player.pos));
  }
  rows.sort((a, b) => a.auctionEndsAt - b.auctionEndsAt);
  return rows.map((L) => publicListing(L, viewerClubId));
}

/** POST bid */
async function placeBid(listingId, clubId, clubName, amount) {
  ensureSeeded();
  await settleExpired();
  const L = listings.get(listingId);
  if (!L) return { ok: false, error: "İhale bulunamadı" };
  if (Date.now() >= L.auctionEndsAt)
    return { ok: false, error: "İhale sona erdi" };
  if (L.sellerClubId && L.sellerClubId === clubId)
    return { ok: false, error: "Kendi ilanına teklif veremezsin" };

  amount = Math.floor(Number(amount) || 0);
  const minNext = Math.max(
    L.currentBid + Math.max(1000, Math.round(L.currentBid * 0.02)),
    L.auctionStart,
  );
  if (amount < minNext) {
    return {
      ok: false,
      error: "Minimum teklif " + minNext.toLocaleString("tr-TR") + " €",
      minNext,
    };
  }

  if (typeof deps.getClub === "function") {
    const club = await _call(deps.getClub, clubId);
    if (!club || Number(club.balance || 0) < amount) {
      return { ok: false, error: "Yetersiz bütçe" };
    }
  }

  // Önceki en yüksek teklif sahibinin blokesi bu tasarımda
  // anlık düşülmez; sonuçlanınca tek seferde tahsil edilir.
  // (Basit model — ileride escrow eklenebilir.)

  L.bidHistory.push({
    clubId,
    clubName,
    amount,
    at: Date.now(),
  });
  L.currentBid = amount;
  L.highestBidderClubId = clubId;
  L.highestBidderName = clubName || "Kulüp";

  // Son 2 dakikada teklif gelirse +2 dk uzat (anti-snipe)
  const left = L.auctionEndsAt - Date.now();
  if (left < 2 * 60 * 1000) {
    L.auctionEndsAt = Date.now() + 2 * 60 * 1000;
  }

  _persist(L);
  _persistBid(listingId, clubId, clubName, amount);
  return { ok: true, listing: publicListing(L, clubId) };
}

/** Kullanıcı kendi oyuncusunu listeler */
async function listPlayerForSale(clubId, clubName, player, openPrice, hours) {
  openPrice = Math.floor(Number(openPrice) || 0);
  hours = Math.floor(Number(hours) || 0);
  if (!player || !player.id) return { ok: false, error: "Oyuncu yok" };
  if (openPrice < 1000) return { ok: false, error: "Min açılış 1.000 €" };
  if (hours < 24) return { ok: false, error: "Min süre 24 saat" };
  if (hours > 168) hours = 168; // max 7 gün

  // Zaten listede mi?
  for (const L of listings.values()) {
    if (
      L.sellerClubId === clubId &&
      String(L.player.id) === String(player.id)
    ) {
      return { ok: false, error: "Bu oyuncu zaten listede" };
    }
  }

  // Takımdan çıkar
  if (typeof deps.getTeam === "function" && typeof deps.saveTeam === "function") {
    const team = await _call(deps.getTeam, clubId);
    if (!team) return { ok: false, error: "Takım bulunamadı" };
    const pid = String(player.id);
    let found = null;
    const bi = (team.bench || []).findIndex((x) => String(x.id) === pid);
    if (bi >= 0) {
      found = team.bench.splice(bi, 1)[0];
    } else {
      const pi = (team.players || []).findIndex((x) => String(x.id) === pid);
      if (pi >= 0) found = team.players.splice(pi, 1)[0];
    }
    if (!found) return { ok: false, error: "Oyuncu kadroda değil" };
    await _call(deps.saveTeam, clubId, team);
    player = found;
  }

  const L = {
    id: uid("lst"),
    player: Object.assign({}, player),
    clubName: clubName || "Kulüp",
    sellerClubId: clubId,
    auctionStart: openPrice,
    currentBid: openPrice,
    highestBidderClubId: null,
    highestBidderName: null,
    auctionEndsAt: Date.now() + hours * 3600 * 1000,
    bidHistory: [],
    createdAt: Date.now(),
  };
  listings.set(L.id, L);
  _persist(L);
  return { ok: true, listing: publicListing(L, clubId) };
}

/** Teklif yoksa listeyi iptal et, oyuncuyu yedeğe iade */
async function cancelListing(listingId, clubId) {
  const L = listings.get(listingId);
  if (!L) return { ok: false, error: "İlan yok" };
  if (L.sellerClubId !== clubId)
    return { ok: false, error: "Bu ilan size ait değil" };
  if (L.highestBidderClubId)
    return { ok: false, error: "Teklif varken çekilemez" };

  listings.delete(listingId);
  _remove(listingId, "cancelled");

  if (typeof deps.getTeam === "function" && typeof deps.saveTeam === "function") {
    const team = await _call(deps.getTeam, clubId);
    if (team) {
      team.bench = team.bench || [];
      team.bench.push(L.player);
      await _call(deps.saveTeam, clubId, team);
    }
  }
  return { ok: true, player: L.player };
}

/** Süresi biten ihaleleri sonuçlandır */
async function settleExpired() {
  const now = Date.now();
  const done = [];
  for (const [id, L] of listings.entries()) {
    if (L.auctionEndsAt > now) continue;
    done.push(id);

    const hasWinner = !!L.highestBidderClubId;
    const price = L.currentBid;

    if (hasWinner) {
      let okPay = true;
      if (typeof deps.adjustBalance === "function") {
        okPay = await _call(
          deps.adjustBalance,
          L.highestBidderClubId,
          -price,
          "Transfer: " + (L.player.name || "Oyuncu"),
        );
        if (!okPay) {
          if (L.sellerClubId && typeof deps.getTeam === "function") {
            const team = await _call(deps.getTeam, L.sellerClubId);
            if (team) {
              team.bench = team.bench || [];
              team.bench.push(L.player);
              await _call(deps.saveTeam, L.sellerClubId, team);
            }
          }
          listings.delete(id);
          _remove(id, "expired");
          continue;
        }
      }
      if (L.sellerClubId && typeof deps.adjustBalance === "function") {
        await _call(
          deps.adjustBalance,
          L.sellerClubId,
          price,
          "Transfer satışı: " + (L.player.name || "Oyuncu"),
        );
      }
      if (typeof deps.getTeam === "function" && typeof deps.saveTeam === "function") {
        const buyerTeam = await _call(deps.getTeam, L.highestBidderClubId);
        if (buyerTeam) {
          buyerTeam.bench = buyerTeam.bench || [];
          const np = Object.assign({}, L.player, {
            fromMarket: true,
            listedByUser: false,
          });
          buyerTeam.bench.push(np);
          await _call(deps.saveTeam, L.highestBidderClubId, buyerTeam);
        }
      }
      deps.log &&
        deps.log(
          "[transfer] sold",
          L.player.name,
          "→",
          L.highestBidderName,
          price,
        );
    } else if (L.sellerClubId) {
      if (typeof deps.getTeam === "function" && typeof deps.saveTeam === "function") {
        const team = await _call(deps.getTeam, L.sellerClubId);
        if (team) {
          team.bench = team.bench || [];
          team.bench.push(L.player);
          await _call(deps.saveTeam, L.sellerClubId, team);
        }
      }
    }
    listings.delete(id);
    _remove(id, hasWinner ? "sold" : "expired");
  }
  return done.length;
}

/** AI piyasasını yenile (kullanıcı ilanları korunur) */
function refreshAiMarket() {
  for (const [id, L] of listings.entries()) {
    if (!L.sellerClubId) {
      listings.delete(id);
      _remove(id, "expired");
    }
  }
  return seedAiListings(8);
}

/** Periyodik settlement timer */
let _timer = null;
function startSettlementTimer(ms) {
  if (_timer) return;
  _timer = setInterval(() => {
    Promise.resolve(settleExpired()).catch((e) => {
      console.error("[transfer] settle", e);
    });
  }, ms || 30 * 1000);
}

function getListing(id) {
  return listings.get(id) || null;
}

function dumpAll() {
  return Array.from(listings.values());
}

function loadAll(arr) {
  listings.clear();
  (arr || []).forEach((L) => {
    if (L && L.id) listings.set(L.id, L);
  });
}

module.exports = {
  configure,
  listMarket,
  placeBid,
  listPlayerForSale,
  cancelListing,
  settleExpired,
  refreshAiMarket,
  seedAiListings,
  startSettlementTimer,
  getListing,
  dumpAll,
  loadAll,
  estimatePlayerValue,
};
