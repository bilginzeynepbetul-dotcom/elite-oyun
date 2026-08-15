// ============================================================
// scripts/smoke-lockout.js — giriş kilidi + admin unlock duman testi
//   API_URL=http://localhost:3000 node scripts/smoke-lockout.js
//
// Opsiyonel admin unlock:
//   SMOKE_ADMIN_USER=admin SMOKE_ADMIN_PASS=... node scripts/smoke-lockout.js
//
// Sunucu LOGIN_MAX_FAILURES (varsayılan 8) kadar yanlış şifre gerekir.
// ============================================================

const API = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const MAX_FAILS = Math.max(
  3,
  Number(process.env.LOGIN_MAX_FAILURES || 8) || 8,
);

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
  return {
    status: res.status,
    ok: res.ok,
    data,
    retryAfter: res.headers.get("retry-after"),
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const tag = "lock_" + Date.now().toString(36);
  const username = "lk_" + tag;
  const password = "test1234";
  let passed = 0;
  let failed = 0;

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

  console.log("[smoke-lockout] API =", API, "MAX_FAILS =", MAX_FAILS);

  await step("register victim", async () => {
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
    assert(
      r.ok || r.status === 201,
      "register " + r.status + " " + JSON.stringify(r.data),
    );
  });

  await step("wrong password until ACCOUNT_LOCKED", async () => {
    let locked = false;
    let last = null;
    for (let i = 0; i < MAX_FAILS + 2; i++) {
      last = await req("/api/auth/login", {
        method: "POST",
        body: { username, password: "wrong-pass-" + i },
      });
      if (last.status === 429 && last.data && last.data.code === "ACCOUNT_LOCKED") {
        locked = true;
        break;
      }
    }
    assert(locked, "ACCOUNT_LOCKED bekleniyordu, son: " + JSON.stringify(last && last.data));
    assert(last.data.locked_until || last.data.retryAfterMs, "locked_until/retryAfterMs yok");
  });

  await step("locked login still blocked with correct password", async () => {
    const r = await req("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
    assert(r.status === 429, "status 429 bekleniyordu, got " + r.status);
    assert(r.data && r.data.code === "ACCOUNT_LOCKED", "code ACCOUNT_LOCKED");
  });

  const adminUser = process.env.SMOKE_ADMIN_USER || process.env.ADMIN_USERNAME;
  const adminPass = process.env.SMOKE_ADMIN_PASS || process.env.ADMIN_PASSWORD;

  if (adminUser && adminPass) {
    let adminAuth = null;
    await step("admin login", async () => {
      const r = await req("/api/auth/login", {
        method: "POST",
        body: { username: adminUser, password: adminPass },
      });
      assert(r.ok, "admin login " + r.status + " " + JSON.stringify(r.data));
      const tok = r.data.accessToken || r.data.token;
      assert(tok, "admin token");
      adminAuth = { Authorization: "Bearer " + tok };
    });

    await step("GET /api/admin/locked includes victim", async () => {
      const r = await req("/api/admin/locked", { headers: adminAuth });
      assert(r.ok, "locked list " + r.status);
      const list = (r.data && (r.data.locked_users || r.data.users)) || [];
      const hit = list.some(
        (u) =>
          String(u.username || "").toLowerCase() === username.toLowerCase(),
      );
      assert(hit, "victim listede yok: " + JSON.stringify(list.map((u) => u.username)));
    });

    await step("POST /api/admin/unlock-login", async () => {
      const r = await req("/api/admin/unlock-login", {
        method: "POST",
        headers: adminAuth,
        body: { target: username },
      });
      assert(r.ok, "unlock " + r.status + " " + JSON.stringify(r.data));
      assert(r.data && r.data.ok, "ok flag");
    });

    await step("login works after unlock", async () => {
      const r = await req("/api/auth/login", {
        method: "POST",
        body: { username, password },
      });
      assert(r.ok, "login after unlock " + r.status + " " + JSON.stringify(r.data));
    });
  } else {
    console.log(
      "  · admin unlock adımları atlandı (SMOKE_ADMIN_USER + SMOKE_ADMIN_PASS verin)",
    );

    await step("reset-password clears lock", async () => {
      const r = await req("/api/auth/reset-password", {
        method: "POST",
        body: {
          username,
          answer: "mavi",
          newPassword: "newpass99",
        },
      });
      assert(r.ok, "reset " + r.status + " " + JSON.stringify(r.data));
      const login = await req("/api/auth/login", {
        method: "POST",
        body: { username, password: "newpass99" },
      });
      assert(
        login.ok,
        "login after reset " + login.status + " " + JSON.stringify(login.data),
      );
    });
  }

  console.log("\n[smoke-lockout] sonuç: %d geçti, %d kaldı", passed, failed);
  if (failed) process.exit(1);
  console.log("[smoke-lockout] OK");
}

main().catch((e) => {
  console.error("[smoke-lockout] fatal", e);
  process.exit(1);
});
