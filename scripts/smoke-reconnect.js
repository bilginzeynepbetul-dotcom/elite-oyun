// ============================================================
// scripts/smoke-reconnect.js — canlı maç socket reconnect
//   API_URL=http://localhost:3000 node scripts/smoke-reconnect.js
// socket.io-client gerekir (devDependency)
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

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let ioClient;
  try {
    ioClient = require("socket.io-client");
  } catch (_) {
    console.error(
      "[smoke-reconnect] socket.io-client yok. npm i -D socket.io-client",
    );
    process.exit(1);
  }

  const tag = "rc_" + Date.now().toString(36);
  const username = "rc_" + tag;
  const password = "test1234";

  console.log("[smoke-reconnect] register…");
  const reg = await req("/api/auth/register", {
    method: "POST",
    body: {
      username,
      password,
      teamName: username + " SK",
      country: "Türkiye",
      securityQuestion: "Test sorusu nedir?",
      securityAnswer: "cevap",
    },
  });
  if (!reg.ok && reg.status !== 201) {
    console.error("register fail", reg.status, reg.data);
    process.exit(1);
  }
  const token = reg.data.accessToken || reg.data.token;
  const authH = { Authorization: "Bearer " + token };

  // vs-bot instant match
  console.log("[smoke-reconnect] instant vs-bot…");
  let matchMeta = null;
  const vs = await req("/api/instant/queue/join", {
    method: "POST",
    headers: authH,
    body: { mode: "vs-bot" },
  });
  // Alternatif endpoint'ler
  if (!vs.ok) {
    const alt = await req("/api/instant/vs-bot", {
      method: "POST",
      headers: authH,
      body: {},
    });
    if (alt.ok) matchMeta = alt.data;
    else {
      console.warn(
        "[smoke-reconnect] instant başlatılamadı — sadece watch API smoke",
        vs.status,
        vs.data,
      );
    }
  } else {
    matchMeta = vs.data;
  }

  const socket = ioClient(API, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: false,
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket connect timeout")), 8000);
    socket.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  console.log("  ✓ socket connect");

  let gotState = false;
  socket.on("match:state", () => {
    gotState = true;
  });

  const fixtureId =
    (matchMeta && (matchMeta.fixtureId || matchMeta.id)) || "smoke_fx";
  const matchId =
    (matchMeta && (matchMeta.matchId || matchMeta.id)) || null;

  socket.emit("fixture:watch", { fixtureId, matchId });
  await wait(1500);
  console.log(gotState ? "  ✓ match:state (ilk)" : "  · state yok (maç canlı olmayabilir)");

  // disconnect + reconnect
  socket.disconnect();
  await wait(400);

  const socket2 = ioClient(API, {
    auth: { token },
    transports: ["websocket", "polling"],
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("reconnect timeout")), 8000);
    socket2.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
    socket2.on("connect_error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
  console.log("  ✓ reconnect");

  let gotState2 = false;
  let gotSide = null;
  socket2.on("match:state", () => {
    gotState2 = true;
  });
  socket2.on("match:your-side", (d) => {
    gotSide = d && d.side;
  });

  socket2.emit("fixture:watch", { fixtureId, matchId });
  await wait(1500);

  if (matchId) {
    socket2.emit("fixture:watch", { matchId });
    await wait(800);
  }

  console.log(
    gotState2 ? "  ✓ match:state (reconnect)" : "  · state yok (beklenen olabilir)",
  );
  if (gotSide) console.log("  ✓ match:your-side =", gotSide);

  socket2.disconnect();
  console.log("[smoke-reconnect] OK");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke-reconnect] FAIL", e.message || e);
  process.exit(1);
});
