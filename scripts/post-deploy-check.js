// ============================================================
// scripts/post-deploy-check.js — canlıya alma sonrası hızlı kontrol
//   API_URL=https://your-domain.com node scripts/post-deploy-check.js
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");

async function get(path) {
  const res = await fetch(API + path, { method: "GET" });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log("[post-deploy] API =", API);
  let failed = 0;
  let passed = 0;

  async function step(name, fn) {
    try {
      await fn();
      console.log("  ✓", name);
      passed++;
    } catch (e) {
      console.error("  ✗", name, "—", e.message || e);
      failed++;
    }
  }

  await step("GET /healthz", async () => {
    const r = await get("/healthz");
    assert(r.ok, "status " + r.status);
    assert(r.data && r.data.ok, "ok flag");
    assert(r.data.db === "up", "db not up: " + (r.data && r.data.db));
  });

  await step("GET /api/health", async () => {
    const r = await get("/api/health");
    assert(r.ok, "status " + r.status);
    assert(r.data && r.data.ok, "ok flag");
    if (r.data.maintenance) {
      console.log("    ⚠ maintenance AÇIK:", r.data.message || r.data.maintenanceSource);
    }
  });

  await step("GET /api/status", async () => {
    const r = await get("/api/status");
    assert(r.ok, "status " + r.status);
  });

  await step("GET /api/version", async () => {
    const r = await get("/api/version");
    assert(r.ok, "version " + r.status);
    assert(r.data && r.data.version, "version field");
    console.log("    version:", r.data.version, "node:", r.data.node);
  });

  await step("GET /readyz", async () => {
    const r = await get("/readyz");
    if (r.data && r.data.reason === "maintenance") {
      console.log("    ⚠ not ready: maintenance");
      assert(r.status === 503, "maintenance should be 503");
      return;
    }
    assert(r.ok, "readyz status " + r.status + " " + JSON.stringify(r.data));
    assert(r.data && r.data.ready === true, "ready flag");
  });

  await step("security headers (sample /api/health)", async () => {
    const r = await get("/api/health");
    // fetch may not expose all headers in browser; node does
    const csp = r.headers.get("content-security-policy");
    const xcto = r.headers.get("x-content-type-options");
    assert(xcto === "nosniff", "X-Content-Type-Options missing");
    // CSP optional warn
    if (!csp) console.log("    · CSP header yok (uyarı)");
  });

  await step("static /privacy.html", async () => {
    const res = await fetch(API + "/privacy.html");
    assert(res.ok || res.status === 200, "privacy " + res.status);
  });

  console.log("\n[post-deploy] sonuç: %d geçti, %d kaldı", passed, failed);
  if (failed) process.exit(1);
  console.log("[post-deploy] OK");
}

main().catch((e) => {
  console.error("[post-deploy] fatal", e);
  process.exit(1);
});
