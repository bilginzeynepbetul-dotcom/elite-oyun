// ============================================================
// scripts/stress-load.js — genel API yük
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const USERS = Math.min(40, Math.max(1, parseInt(process.env.STRESS_USERS || "12", 10)));
const ROUNDS = Math.max(1, parseInt(process.env.STRESS_ROUNDS || "3", 10));
const CONCURRENCY = Math.max(1, parseInt(process.env.STRESS_CONCURRENCY || "8", 10));

async function req(path, opts = {}) {
  const t0 = Date.now();
  try {
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
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, path, data };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, path, error: e.message };
  }
}

async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function registerUser(i) {
  const tag = "ld" + Date.now().toString(36) + "_" + i;
  const username = "l_" + tag;
  const r = await req("/api/auth/register", {
    method: "POST",
    body: {
      username,
      password: "test1234",
      teamName: username + " SK",
      country: "Türkiye",
      securityQuestion: "Güvenlik sorusu en az beş?",
      securityAnswer: "evet",
    },
  });
  if (!(r.ok || r.status === 201)) return { ok: false, r };
  return {
    ok: true,
    token: r.data.accessToken || r.data.token,
    username,
  };
}

async function userRound(token) {
  const auth = { Authorization: "Bearer " + token };
  const paths = [
    "/api/me",
    "/api/team",
    "/api/economy",
    "/api/league/standings",
    "/api/fixtures",
    "/api/fixtures/next",
    "/api/youth",
    "/api/stadium",
    "/api/training",
    "/api/transfer/market",
    "/api/forum",
    "/api/notifications",
  ];
  const results = [];
  for (const p of paths) {
    results.push(await req(p, { headers: auth }));
  }
  return results;
}

async function main() {
  console.log(
    "[stress-load] users=%d rounds=%d concurrency=%d API=%s",
    USERS,
    ROUNDS,
    CONCURRENCY,
    API,
  );
  const t0 = Date.now();

  const users = await poolMap(
    Array.from({ length: USERS }, (_, i) => i),
    CONCURRENCY,
    registerUser,
  );
  const authed = users.filter((u) => u.ok);
  console.log("registered %d/%d", authed.length, USERS);

  const all = [];
  for (let r = 0; r < ROUNDS; r++) {
    const batch = await poolMap(authed, CONCURRENCY, (u) => userRound(u.token));
    for (const list of batch) all.push(...list);
  }

  const elapsed = (Date.now() - t0) / 1000;
  const okN = all.filter((x) => x.ok).length;
  const ms = all.map((x) => x.ms).sort((a, b) => a - b);
  const p = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] || 0;

  const byPath = {};
  for (const x of all) {
    if (!byPath[x.path]) byPath[x.path] = { n: 0, sum: 0, fail: 0 };
    byPath[x.path].n++;
    byPath[x.path].sum += x.ms;
    if (!x.ok) byPath[x.path].fail++;
  }

  console.log("---");
  console.log(
    "ok=%d/%d (%.0f%%)  elapsed=%.1fs  RPS≈%.1f",
    okN,
    all.length,
    (okN / Math.max(1, all.length)) * 100,
    elapsed,
    all.length / elapsed,
  );
  console.log("latency ms: p50=%d p95=%d p99=%d", p(0.5), p(0.95), p(0.99));
  console.log("path averages:");
  for (const [path, s] of Object.entries(byPath)) {
    console.log(
      "  %s  avg=%dms  fail=%d/%d",
      path,
      Math.round(s.sum / s.n),
      s.fail,
      s.n,
    );
  }

  const samples = all.filter((x) => !x.ok).slice(0, 8);
  if (samples.length) {
    console.log("sample errors:");
    for (const s of samples) {
      console.log("  ", s.path, s.status, s.error || "");
    }
  }

  if (okN / Math.max(1, all.length) < 0.85 || p(0.95) > 8000) {
    process.exit(1);
  }
  console.log("[stress-load] OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
