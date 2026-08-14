// ============================================================
// scripts/integration-test.js — kayıt → kadro → youth → transfer akışı
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");

async function req(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {},
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, ok: res.ok || res.status === 201, data };
}

function assert(c, m) {
  if (!c) throw new Error(m);
}

async function main() {
  console.log("[integration] API =", API);
  const tag = "it_" + Date.now().toString(36);
  const username = "it_" + tag;

  const reg = await req("/api/auth/register", {
    method: "POST",
    body: {
      username,
      password: "test1234",
      teamName: username + " SK",
      country: "Türkiye",
      securityQuestion: "En sevdiğin takım nedir?",
      securityAnswer: "galatasaray",
    },
  });
  assert(reg.ok, "register " + reg.status + " " + JSON.stringify(reg.data));
  const token = reg.data.accessToken || reg.data.token;
  const auth = { Authorization: "Bearer " + token };
  console.log("  ✓ register");

  const team = await req("/api/team", { headers: auth });
  assert(team.ok, "team");
  const players = team.data.players || (team.data.team && team.data.team.players) || [];
  assert(players.length >= 11, "XI eksik: " + players.length);
  console.log("  ✓ team (%d starters)", players.length);

  const youth = await req("/api/youth", { headers: auth });
  assert(youth.ok, "youth state");
  console.log("  ✓ youth state scout=%s", youth.data.scoutLevel);

  const draw = await req("/api/youth/draw", {
    method: "POST",
    headers: auth,
    body: { preferredSkill: "pace" },
  });
  assert(draw.ok, "youth draw " + JSON.stringify(draw.data));
  assert(draw.data.player && draw.data.player.name, "player yok");
  console.log("  ✓ youth draw →", draw.data.player.name);

  const stadium = await req("/api/stadium", { headers: auth });
  assert(stadium.ok, "stadium");
  console.log("  ✓ stadium cap=%s", stadium.data.capacity);

  const train = await req("/api/training", { headers: auth });
  assert(train.ok, "training");
  console.log("  ✓ training");

  const benchId =
    (team.data.bench && team.data.bench[0] && team.data.bench[0].id) ||
    (players[10] && players[10].id);
  if (benchId) {
    const list = await req("/api/transfer/list", {
      method: "POST",
      headers: auth,
      body: { playerId: benchId, minPrice: 50000, hours: 1 },
    });
    // Kadro kuralı yüzünden red olabilir; 400 kabul
    console.log(
      list.ok ? "  ✓ transfer list" : "  · transfer list: " + (list.data && list.data.error),
    );
  }

  const market = await req("/api/transfer/market", { headers: auth });
  assert(market.ok, "market");
  console.log("  ✓ transfer market (%d)", (market.data.listings || []).length);

  const forum = await req("/api/forum", {
    method: "POST",
    headers: auth,
    body: { text: "Integration test mesajı " + tag },
  });
  assert(forum.ok, "forum post");
  console.log("  ✓ forum post");

  console.log("[integration] OK");
}

main().catch((e) => {
  console.error("[integration] FAIL", e.message);
  process.exit(1);
});
