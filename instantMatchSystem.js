// ============================================================
// instantMatchSystem.js — Anlık maç (bot + gerçek kullanıcı)
// In-memory: online presence, challenges, live match registry
// ============================================================

const crypto = require("crypto");
const clubsRepo = require("./repos/clubsRepo");
const { query } = require("./db");

/** userId -> { userId, username, clubId, socketId, at } */
const online = new Map();
/** challengeId -> challenge */
const challenges = new Map();
/** matchKey (fixtureId) -> meta */
const instantMeta = new Map();

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function setOnline(userId, info) {
  if (!userId) return;
  online.set(String(userId), {
    userId: String(userId),
    username: (info && info.username) || "Menajer",
    clubId: info && info.clubId ? String(info.clubId) : null,
    socketId: info && info.socketId ? String(info.socketId) : null,
    at: Date.now(),
  });
}

function setOffline(userId, socketId) {
  if (!userId) return;
  const cur = online.get(String(userId));
  if (cur && socketId && cur.socketId && cur.socketId !== socketId) return;
  online.delete(String(userId));
}

function listOnline(excludeUserId) {
  const now = Date.now();
  const out = [];
  for (const [id, u] of online.entries()) {
    if (now - u.at > 10 * 60 * 1000) {
      online.delete(id);
      continue;
    }
    if (excludeUserId && String(id) === String(excludeUserId)) continue;
    out.push({
      userId: u.userId,
      username: u.username,
      clubId: u.clubId,
      online: true,
    });
  }
  return out.sort((a, b) =>
    String(a.username).localeCompare(String(b.username), "tr"),
  );
}

function touch(userId) {
  const u = online.get(String(userId));
  if (u) u.at = Date.now();
}

async function pickBotOpponent(myClubId) {
  const me = await clubsRepo.getClub(myClubId);
  if (!me) throw new Error("Kulübün yok");
  const { rows } = await query(
    `SELECT id, name FROM clubs
     WHERE country = $1 AND division = $2 AND id <> $3
       AND COALESCE(is_bot, FALSE) = TRUE
     ORDER BY RANDOM()
     LIMIT 1`,
    [me.country, me.division, myClubId],
  );
  if (rows[0]) return rows[0];
  // fallback: any bot
  const { rows: any } = await query(
    `SELECT id, name FROM clubs
     WHERE COALESCE(is_bot, FALSE) = TRUE AND id <> $1
     ORDER BY RANDOM() LIMIT 1`,
    [myClubId],
  );
  if (!any[0]) throw new Error("Uygun bot rakip bulunamadı (lig botları yok)");
  return any[0];
}

async function listHumanOpponents(myClubId, myUserId) {
  const onlineList = listOnline(myUserId);
  const me = await clubsRepo.getClub(myClubId);
  const { rows } = await query(
    `SELECT c.id, c.name, c.user_id AS "userId", u.username
     FROM clubs c
     JOIN users u ON u.id = c.user_id
     WHERE COALESCE(c.is_bot, FALSE) = FALSE
       AND c.id <> $1
       AND c.user_id IS NOT NULL
       AND COALESCE(u.is_banned, FALSE) = FALSE
     ORDER BY u.username
     LIMIT 80`,
    [myClubId],
  );
  const onlineSet = new Set(onlineList.map((o) => String(o.userId)));
  return rows.map((r) => ({
    userId: String(r.userId),
    username: r.username,
    clubId: r.id,
    clubName: r.name,
    online: onlineSet.has(String(r.userId)),
    sameCountry: me ? r.id /* placeholder */ : false,
  }));
}

/**
 * Challenge a human opponent (must accept).
 */
function createChallenge({ fromUserId, fromUsername, fromClubId, toUserId, toUsername, toClubId }) {
  if (String(fromUserId) === String(toUserId)) {
    return { ok: false, error: "Kendine meydan okuyamazsın" };
  }
  // one pending challenge from same user
  for (const c of challenges.values()) {
    if (
      c.status === "pending" &&
      String(c.fromUserId) === String(fromUserId) &&
      String(c.toUserId) === String(toUserId)
    ) {
      return { ok: false, error: "Bu kullanıcıya zaten bekleyen teklif var", challenge: c };
    }
  }
  const id = "ch_" + uid();
  const challenge = {
    id,
    fromUserId: String(fromUserId),
    fromUsername: fromUsername || "Menajer",
    fromClubId: String(fromClubId),
    toUserId: String(toUserId),
    toUsername: toUsername || "Rakip",
    toClubId: toClubId ? String(toClubId) : null,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + 90 * 1000,
  };
  challenges.set(id, challenge);
  return { ok: true, challenge };
}

function getChallenge(id) {
  return challenges.get(String(id)) || null;
}

function listPendingForUser(userId) {
  const now = Date.now();
  const out = [];
  for (const c of challenges.values()) {
    if (c.status !== "pending") continue;
    if (c.expiresAt < now) {
      c.status = "expired";
      continue;
    }
    if (
      String(c.toUserId) === String(userId) ||
      String(c.fromUserId) === String(userId)
    ) {
      out.push(c);
    }
  }
  return out;
}

function respondChallenge(challengeId, userId, accept) {
  const c = challenges.get(String(challengeId));
  if (!c) return { ok: false, error: "Teklif bulunamadı" };
  if (c.status !== "pending") return { ok: false, error: "Teklif artık geçerli değil" };
  if (c.expiresAt < Date.now()) {
    c.status = "expired";
    return { ok: false, error: "Teklif süresi doldu" };
  }
  if (String(c.toUserId) !== String(userId)) {
    return { ok: false, error: "Bu teklifi yalnızca rakip yanıtlayabilir" };
  }
  c.status = accept ? "accepted" : "declined";
  c.respondedAt = Date.now();
  return { ok: true, challenge: c };
}

function registerInstantMeta(fixtureId, meta) {
  instantMeta.set(String(fixtureId), Object.assign({ at: Date.now() }, meta));
}

function getInstantMeta(fixtureId) {
  return instantMeta.get(String(fixtureId)) || null;
}

module.exports = {
  setOnline,
  setOffline,
  listOnline,
  touch,
  pickBotOpponent,
  listHumanOpponents,
  createChallenge,
  getChallenge,
  listPendingForUser,
  respondChallenge,
  registerInstantMeta,
  getInstantMeta,
  challenges,
  online,
};
