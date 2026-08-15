// ============================================================
// scripts/smoke.js — temel API duman testi
//   API_URL=http://localhost:3000 node scripts/smoke.js
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");

async function req(path, opts = {}) {
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts.headers || {},
  );
  const res = await fetch(API + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, ok: res.ok, data };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const tag = "smk_" + Date.now().toString(36);
  const username = "u_" + tag;
  const password = "test1234";
  let passed = 0;
  let failed = 0;

  async function step(name, fn) {
    try {
      await fn();
      console.log("  ✓", name);
      passed++;
    } catch (e) {
      console.error("  ✗", name, "—", e.message);
      failed++;
    }
  }

  console.log("[smoke] API =", API);

  await step("GET /api/health", async () => {
    const r = await req("/api/health");
    assert(r.ok, "health status " + r.status);
    assert(r.data && r.data.ok, "ok flag");
  });

  let tokens = null;
  let club = null;

  await step("POST /api/auth/register", async () => {
    const r = await req("/api/auth/register", {
      method: "POST",
      body: {
        username,
        password,
        email: username + "@test.local",
        teamName: username + " SK",
        country: "Türkiye",
        securityQuestion: "En sevdiğin renk?",
        securityAnswer: "mavi",
      },
    });
    assert(r.ok || r.status === 201, "register " + r.status + " " + JSON.stringify(r.data));
    assert(r.data.accessToken || r.data.token, "token yok");
    tokens = r.data;
    club = r.data.club;
  });

  await step("POST /api/auth/login", async () => {
    const r = await req("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    assert(r.ok, "login " + r.status);
    assert(r.data.accessToken || r.data.token, "token");
    tokens = r.data;
  });

  const auth = {
    Authorization: "Bearer " + (tokens.accessToken || tokens.token),
  };

  await step("POST /api/auth/refresh", async () => {
    if (!tokens.refreshToken) {
      console.log("    (refreshToken yok — atlandı)");
      return;
    }
    const r = await req("/api/auth/refresh", {
      method: "POST",
      body: { refreshToken: tokens.refreshToken },
    });
    assert(r.ok, "refresh " + r.status);
    tokens = r.data;
    auth.Authorization = "Bearer " + (tokens.accessToken || tokens.token);
  });

  await step("GET /api/me", async () => {
    const r = await req("/api/me", { headers: auth });
    assert(r.ok, "/me " + r.status);
    assert(r.data.user && r.data.user.username === username, "username");
  });

  await step("GET /api/team", async () => {
    const r = await req("/api/team", { headers: auth });
    assert(r.ok, "/team " + r.status);
    assert(
      (r.data.players && r.data.players.length >= 11) ||
        (r.data.team && r.data.team.players),
      "kadro eksik",
    );
  });

  await step("GET /api/economy", async () => {
    const r = await req("/api/economy", { headers: auth });
    assert(r.ok, "/economy " + r.status);
  });

  await step("GET /api/league/standings", async () => {
    const r = await req("/api/league/standings", { headers: auth });
    assert(r.ok, "/standings " + r.status);
  });

  await step("GET /api/youth", async () => {
    const r = await req("/api/youth", { headers: auth });
    assert(r.ok, "/youth " + r.status);
  });

  await step("GET /api/stadium", async () => {
    const r = await req("/api/stadium", { headers: auth });
    assert(r.ok, "/stadium " + r.status);
  });

  await step("GET /api/training", async () => {
    const r = await req("/api/training", { headers: auth });
    assert(r.ok, "/training " + r.status);
  });

  await step("GET /api/transfer/market", async () => {
    const r = await req("/api/transfer/market", { headers: auth });
    assert(r.ok, "/transfer/market " + r.status);
  });

  await step("GET /api/fixtures/next", async () => {
    const r = await req("/api/fixtures/next", { headers: auth });
    assert(r.ok, "/fixtures/next " + r.status);
  });

  console.log("\n[smoke] sonuç: %d geçti, %d kaldı", passed, failed);
  if (failed) process.exit(1);
  console.log("[smoke] OK");
}

main().catch((e) => {
  console.error("[smoke] fatal", e);
  process.exit(1);
});
