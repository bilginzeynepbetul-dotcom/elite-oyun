/**
 * stress-instant.js — Anlık maç kuyruk / vs-bot stres testi
 * Kullanım: API_URL=http://localhost:3000 node scripts/stress-instant.js
 * Sunucu açık olmalı.
 */
const BASE = process.env.API_URL || "http://localhost:3000";
const N = Math.min(20, parseInt(process.env.STRESS_USERS || "6", 10) || 6);

async function req(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.status + " " + path);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function reg(i) {
  const u = "st" + Date.now().toString(36).slice(-4) + i;
  const r = await req("POST", "/api/auth/register", {
    username: u,
    password: "test1234",
    teamName: u + " SK",
  });
  return { u, token: r.token };
}

async function main() {
  console.log("[stress] base", BASE, "users", N);
  await req("GET", "/health");
  const users = [];
  for (let i = 0; i < N; i++) {
    users.push(await reg(i));
    process.stdout.write(".");
  }
  console.log("\n[stress] registered", users.length);

  // presence all
  await Promise.all(
    users.map((x) =>
      req("POST", "/api/instant/presence", {}, x.token).catch(() => null),
    ),
  );
  console.log("[stress] presence ok");

  // queue join all (pair matching)
  const joins = await Promise.all(
    users.map((x) =>
      req("POST", "/api/instant/queue/join", {}, x.token).catch((e) => ({
        error: e.message,
        data: e.data,
      })),
    ),
  );
  const matched = joins.filter((j) => j && j.matched).length;
  const queued = joins.filter((j) => j && j.queued && !j.matched).length;
  const errors = joins.filter((j) => j && j.error).length;
  console.log("[stress] queue matched=", matched, "queued=", queued, "err=", errors);

  // vs-bot for first user
  try {
    const bot = await req("POST", "/api/instant/vs-bot", {}, users[0].token);
    console.log("[stress] vs-bot", bot.fixtureId || bot.matchId || bot);
  } catch (e) {
    console.log("[stress] vs-bot", e.message);
  }

  // leave queues
  await Promise.all(
    users.map((x) =>
      req("POST", "/api/instant/queue/leave", {}, x.token).catch(() => null),
    ),
  );
  console.log("[stress] done");
}

main().catch((e) => {
  console.error("[stress] FAIL", e.message);
  process.exit(1);
});
