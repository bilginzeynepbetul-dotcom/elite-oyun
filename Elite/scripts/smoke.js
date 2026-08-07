// End-to-end smoke: core + social + transfer + youth + training
const BASE = process.env.API_URL || "http://localhost:3000";

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || res.status + " " + path);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT: " + msg);
}

async function main() {
  console.log("[smoke] base", BASE);

  const health = await req("GET", "/health");
  assert(health.ok, "health");

  const u =
    "u" + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 99);
  const reg = await req("POST", "/api/auth/register", {
    username: u,
    password: "test1234",
    teamName: u + " SK",
  });
  assert(reg.token, "token");
  assert(reg.club && reg.club.id, "club");
  console.log("[smoke] registered", u, reg.club.name);
  const token = reg.token;

  // second user for messaging
  const u2 =
    "v" + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 99);
  const reg2 = await req("POST", "/api/auth/register", {
    username: u2,
    password: "test1234",
    teamName: u2 + " SK",
  });
  assert(reg2.token && reg2.user, "user2");
  console.log("[smoke] registered2", u2);

  const me = await req("GET", "/api/me", null, token);
  assert(me.user && me.user.username === u, "me username");

  const team = await req("GET", "/api/team", null, token);
  assert(team.team && team.team.players && team.team.players.length >= 11, "starters");
  console.log("[smoke] squad", team.team.players.length, "+", (team.team.bench || []).length);

  const eco = await req("GET", "/api/economy", null, token);
  assert(typeof eco.balance === "number", "balance");
  console.log("[smoke] balance", eco.balance);

  // League
  const fill = await req(
    "POST",
    "/api/league/fill-bots",
    { targetSize: 10, forceFixtures: true },
    token,
  );
  console.log("[smoke] fill-bots", fill.created, "bots");

  const counts = await req("GET", "/api/league/club-counts", null, token);
  assert(counts.total >= 10, "total clubs >= 10");

  const standings = await req("GET", "/api/league/standings", null, token);
  assert(standings.standings && standings.standings.length >= 10, "standings");

  const next = await req("GET", "/api/fixtures/next", null, token);
  assert(next.fixture, "next fixture");
  const kickMs = new Date(next.fixture.kickoffAt).getTime() - Date.now();
  assert(kickMs < 24 * 3600 * 1000, "kickoff within 24h");
  console.log(
    "[smoke] next",
    next.fixture.homeName,
    "vs",
    next.fixture.awayName,
    "kickoff in",
    Math.round(kickMs / 60000),
    "min",
  );

  const stadium = await req("GET", "/api/stadium", null, token);
  assert(stadium.stadium && stadium.stadium.capacity, "stadium");
  const cap0 = stadium.stadium.capacity;
  const up = await req("POST", "/api/stadium/upgrade", {}, token);
  assert(up.ok && up.state && up.state.capacity === cap0 + 1000, "stadium upgrade");
  console.log("[smoke] stadium", cap0, "→", up.state.capacity);


  // Forum
  const forum0 = await req("GET", "/api/forum", null, token);
  assert(Array.isArray(forum0.posts), "forum posts array");
  const forumPost = await req(
    "POST",
    "/api/forum",
    { text: "Smoke test post " + u },
    token,
  );
  assert(forumPost.ok || forumPost.post || forumPost.posts, "forum post ok");
  const forum1 = await req("GET", "/api/forum", null, token);
  assert(
    forum1.posts.some((p) => (p.text || "").includes("Smoke test")),
    "forum contains post",
  );
  console.log("[smoke] forum posts", forum1.posts.length);

  // Messages
  const inbox = await req("GET", "/api/messages", null, token);
  assert(Array.isArray(inbox.messages), "messages array");
  assert(Array.isArray(inbox.recipients), "recipients array");
  const target = (inbox.recipients || []).find(
    (r) => String(r.username).toLowerCase() === u2.toLowerCase(),
  );
  assert(target, "recipient user2");
  const sent = await req(
    "POST",
    "/api/messages",
    {
      toUserId: target.userId,
      toUsername: target.username,
      text: "Merhaba " + u2,
    },
    token,
  );
  assert(sent.ok, "message sent");
  const inbox2 = await req("GET", "/api/messages", null, reg2.token);
  assert(
    (inbox2.messages || []).some((m) => (m.text || "").includes("Merhaba")),
    "user2 received message",
  );
  console.log("[smoke] message ok");

  // Notifications (user2 should have unread from message)
  const notif = await req("GET", "/api/notifications", null, reg2.token);
  assert(Array.isArray(notif.notifications), "notifications");
  assert((notif.unread || 0) >= 1, "unread >= 1");
  await req("POST", "/api/notifications/read", {}, reg2.token);
  const notif2 = await req("GET", "/api/notifications", null, reg2.token);
  assert((notif2.unread || 0) === 0, "unread cleared");
  console.log("[smoke] notifications ok");

  // Transfer market
  const market = await req("GET", "/api/transfer/market", null, token);
  assert(Array.isArray(market.listings), "listings");
  assert(market.listings.length >= 1, "at least 1 listing");
  const L = market.listings[0];
  const bidAmount = Math.max(
    (L.currentBid || 0) + 5000,
    (L.auctionStart || 0) + 5000,
  );
  const bid = await req(
    "POST",
    "/api/transfer/bid",
    { listingId: L.id, amount: bidAmount },
    token,
  );
  assert(bid.ok, "bid ok");
  console.log("[smoke] transfer bid", L.id, bidAmount);

  // Youth
  const youth = await req("GET", "/api/youth", null, token);
  assert(youth.youth, "youth state");
  console.log(
    "[smoke] youth scout",
    youth.youth.scoutLevel,
    "academy",
    youth.youth.academyLevel,
  );

  // Training
  const training = await req("GET", "/api/training", null, token);
  assert(training.coaches, "coaches");
  const pid = team.team.players[0].id;
  const tr = await req(
    "POST",
    "/api/training/player",
    { playerId: pid, skill: "stamina" },
    token,
  );
  assert(tr.ok, "train player");
  console.log("[smoke] trained", tr.name || pid, tr.delta);

  console.log("[smoke] OK — full suite");
}

main().catch((e) => {
  console.error("[smoke] FAIL", e.message, e.data || "");
  process.exit(1);
});
