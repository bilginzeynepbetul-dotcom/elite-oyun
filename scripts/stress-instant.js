// ============================================================
// scripts/stress-instant.js — anlık maç kuyruğu yükü
//   API_URL=http://localhost:3000 STRESS_USERS=10 npm run test:stress
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const N = Math.min(40, Math.max(1, parseInt(process.env.STRESS_USERS || "10", 10)));

async function req(path, opts = {}) {
  const t0 = Date.now();
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    opts.headers || {},
  );
  let status = 0;
  let ok = false;
  let data = null;
  try {
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    status = res.status;
    ok = res.ok;
    try {
      data = await res.json();
    } catch (_) {}
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  }
  return { ok, status, ms: Date.now() - t0, data };
}

async function oneUser(i) {
  const tag = "st" + Date.now().toString(36) + "_" + i;
  const username = "s_" + tag;
  const password = "test1234";
  const steps = [];

  const reg = await req("/api/auth/register", {
    method: "POST",
    body: {
      username,
      password,
      teamName: username + " SK",
      country: "Türkiye",
      securityQuestion: "Soru test için yeterli mi?",
      securityAnswer: "evet",
    },
  });
  steps.push({ path: "register", ok: reg.ok || reg.status === 201, ms: reg.ms });
  if (!(reg.ok || reg.status === 201)) return { i, steps, ok: false };

  const token = reg.data.accessToken || reg.data.token;
  const auth = { Authorization: "Bearer " + token };

  const presence = await req("/api/instant/presence", { headers: auth });
  steps.push({ path: "presence", ok: presence.ok || presence.status === 404, ms: presence.ms });

  const join = await req("/api/instant/queue/join", {
    method: "POST",
    headers: auth,
    body: { mode: "vs-bot" },
  });
  steps.push({
    path: "queue/join",
    ok: join.ok || join.status === 404 || join.status === 400,
    ms: join.ms,
    status: join.status,
  });

  const vs = await req("/api/instant/vs-bot", {
    method: "POST",
    headers: auth,
    body: {},
  });
  steps.push({
    path: "vs-bot",
    ok: vs.ok || vs.status === 404 || vs.status === 400,
    ms: vs.ms,
    status: vs.status,
  });

  const ok = steps.every((s) => s.ok);
  return { i, username, steps, ok };
}

async function main() {
  console.log("[stress-instant] users=%d API=%s", N, API);
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => oneUser(i)),
  );
  const elapsed = (Date.now() - t0) / 1000;
  const okN = results.filter((r) => r.ok).length;
  const allMs = results.flatMap((r) => r.steps.map((s) => s.ms)).sort((a, b) => a - b);
  const p = (q) => allMs[Math.min(allMs.length - 1, Math.floor(q * allMs.length))] || 0;

  console.log("---");
  console.log("ok=%d/%d (%.0f%%)  elapsed=%.1fs  RPS≈%.1f", okN, N, (okN / N) * 100, elapsed, (results.flatMap((r) => r.steps).length) / elapsed);
  console.log("latency ms: p50=%d p95=%d p99=%d", p(0.5), p(0.95), p(0.99));
  const fails = results.filter((r) => !r.ok).slice(0, 5);
  for (const f of fails) {
    console.log(" fail", f.i, f.steps.map((s) => s.path + ":" + (s.status || (s.ok ? "ok" : "x"))).join(" "));
  }
  if (okN / N < 0.85) process.exit(1);
  console.log("[stress-instant] OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
