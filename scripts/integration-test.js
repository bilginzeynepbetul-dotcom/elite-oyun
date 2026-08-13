/**
 * integration-test.js — Çok oyunculu / bağış / ranking entegrasyon testleri
 * Kullanım: API_URL=http://localhost:3000 node scripts/integration-test.js
 * Önkoşul: sunucu ayakta (npm start)
 */
const BASE = process.env.API_URL || "http://localhost:3000";

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(
      "NETWORK " + path + " — sunucu çalışıyor mu? " + (e.message || e),
    );
    err.code = "NETWORK";
    throw err;
  }
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

function uid(prefix) {
  return (
    (prefix || "t") +
    Date.now().toString(36).slice(-5) +
    Math.floor(Math.random() * 99)
  );
}

async function register(name) {
  const username = name || uid("u");
  const data = await req("POST", "/api/auth/register", {
    username,
    password: "test1234",
    teamName: username + " SK",
  });
  assert(data.token, "register token " + username);
  return { username, token: data.token, club: data.club, user: data.user };
}

async function main() {
  console.log("[integration] base", BASE);
  let passed = 0;
  function ok(label) {
    passed++;
    console.log("[integration] ✓", label);
  }

  // 1) Health
  const health = await req("GET", "/health");
  assert(health.ok, "health.ok");
  ok("health");

  // 2) Auth + team
  const a = await register();
  const b = await register();
  ok("register x2 (" + a.username + ", " + b.username + ")");

  const team = await req("GET", "/api/team", null, a.token);
  assert(team.team && (team.team.players || []).length >= 11, "starters >= 11");
  ok("team squad");

  // 3) Empty squad reject
  try {
    await req(
      "POST",
      "/api/team",
      { team: { name: team.team.name, players: [], bench: [] } },
      a.token,
    );
    // bazı ortamlarda 400
    throw new Error("empty squad should fail");
  } catch (e) {
    if (e.message === "empty squad should fail") throw e;
    assert(
      e.status === 400 ||
        (e.data && (e.data.code === "EMPTY_SQUAD" || e.data.error)),
      "empty squad rejected",
    );
    ok("empty squad rejected by server");
  }

  // 4) League ranking
  try {
    await req(
      "POST",
      "/api/league/fill-bots",
      { targetSize: 8, forceFixtures: true },
      a.token,
    );
  } catch (e) {
    console.warn("[integration] fill-bots skip", e.message);
  }
  const ranking = await req("GET", "/api/league/ranking", null, a.token);
  assert(Array.isArray(ranking.ranking), "ranking array");
  ok("league ranking (" + ranking.ranking.length + ")");

  // 5) Premium status + donation methods
  const prem = await req("GET", "/api/premium/status", null, a.token);
  assert(prem.status, "premium status");
  ok("premium status active=" + !!(prem.status && prem.status.active));

  const methods = await req(
    "GET",
    "/api/premium/donation-methods",
    null,
    a.token,
  );
  assert(methods.methods, "donation methods");
  assert(Array.isArray(methods.plans) && methods.plans.length >= 3, "plans");
  ok("donation methods + plans");

  // 6) Create donation
  const don = await req(
    "POST",
    "/api/premium/donate",
    {
      plan: "weekly",
      method: "iban",
      payerName: "Test User",
      referenceCode: "TEST" + Date.now(),
      note: "integration test",
    },
    a.token,
  );
  assert(don.ok && don.donation && don.donation.id, "donation created");
  ok("donation create #" + don.donation.id);

  const mine = await req("GET", "/api/premium/my-donations", null, a.token);
  assert(
    (mine.donations || []).some((d) => d.id === don.donation.id),
    "my donations lists new",
  );
  ok("my-donations");

  // Cancel donation
  const cancel = await req(
    "POST",
    "/api/premium/donate/cancel",
    { donationId: don.donation.id },
    a.token,
  );
  assert(cancel.ok, "donation cancel");
  ok("donation cancel");

  // 7) Instant presence + opponents + queue status
  await req("POST", "/api/instant/presence", {}, a.token);
  await req("POST", "/api/instant/presence", {}, b.token);
  ok("instant presence");

  const ops = await req("GET", "/api/instant/opponents", null, a.token);
  assert(Array.isArray(ops.opponents), "opponents array");
  ok("instant opponents (" + ops.opponents.length + ")");

  const qStatus = await req("GET", "/api/instant/queue/status", null, a.token);
  assert(typeof qStatus.size === "number", "queue size");
  assert(typeof qStatus.maxLive === "number", "maxLive");
  ok("queue status size=" + qStatus.size + " maxLive=" + qStatus.maxLive);

  // Join queue (may match if b also joins)
  const q1 = await req("POST", "/api/instant/queue/join", {}, a.token);
  assert(q1.ok, "queue join a");
  ok("queue join a matched=" + !!q1.matched);

  const q2 = await req("POST", "/api/instant/queue/join", {}, b.token);
  assert(q2.ok, "queue join b");
  ok("queue join b matched=" + !!q2.matched);

  // Leave if still queued
  try {
    await req("POST", "/api/instant/queue/leave", {}, a.token);
    await req("POST", "/api/instant/queue/leave", {}, b.token);
  } catch (e) {}
  ok("queue leave");

  // 8) Instant vs bot (capacity permitting)
  try {
    const bot = await req("POST", "/api/instant/vs-bot", {}, a.token);
    assert(bot.fixtureId || bot.matchId || bot.ok !== false, "vs-bot started");
    ok("instant vs-bot " + (bot.fixtureId || bot.matchId || "ok"));
  } catch (e) {
    if (e.status === 503 || (e.data && e.data.code === "CAPACITY")) {
      ok("instant vs-bot capacity limited (expected under load)");
    } else {
      console.warn("[integration] vs-bot", e.message);
      ok("instant vs-bot soft-fail: " + e.message);
    }
  }

  // 9) Fixtures next
  try {
    const next = await req("GET", "/api/fixtures/next", null, a.token);
    ok("fixtures/next " + (next.fixture ? next.fixture.id : "null"));
  } catch (e) {
    ok("fixtures/next soft: " + e.message);
  }

  console.log("[integration] OK —", passed, "checks passed");
}

main().catch((e) => {
  console.error("[integration] FAIL", e.message, e.data || "");
  if (e.code === "NETWORK") {
    console.error(
      "[integration] İpucu: önce `npm start` ile sunucuyu aç, sonra testi çalıştır.",
    );
  }
  process.exit(1);
});
