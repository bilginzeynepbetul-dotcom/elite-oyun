// ============================================================
// multiplayer-client.js — Elite Manager Online (CLIENT)
// ------------------------------------------------------------
// Kullanım:
//   1) <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
//   2) <script src="multiplayer-client.js"></script>
//   3) window.EM_ONLINE = true;  window.EM_API_BASE = "http://localhost:3001";
//
// ONLINE iken Maçı Başlat → kuyruk → sunucu maçı oynatır.
// Local runMatchTick / circulateBall ÇALIŞMAZ.
// ============================================================

(function (global) {
  "use strict";

  const API_BASE =
    global.EM_API_BASE ||
    localStorage.getItem("em_api_base") ||
    "http://localhost:3001";

  let socket = null;
  let authToken = localStorage.getItem("em_token") || null;
  let currentMatchId = null;
  let onlineActive = false; // bu oturumda online maç mı

  // ---------------- REST ----------------
  async function api(path, opts = {}) {
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {},
    );
    if (authToken) headers.Authorization = "Bearer " + authToken;
    const res = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "İstek başarısız");
    return data;
  }

  async function registerAccount(username, password) {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    authToken = data.token;
    localStorage.setItem("em_token", data.token);
    return data;
  }

  async function loginAccount(username, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    authToken = data.token;
    localStorage.setItem("em_token", data.token);
    return data;
  }

  /** Mevcut teamConfig.home'u sunucuya kaydet */
  async function syncTeamToServer() {
    if (typeof teamConfig === "undefined" || !teamConfig.home) {
      throw new Error("teamConfig.home yok");
    }
    const team = sanitizeTeam(teamConfig.home);
    await api("/api/team", {
      method: "POST",
      body: JSON.stringify({ team }),
    });
    return team;
  }

  async function loadTeamFromServer() {
    const data = await api("/api/team");
    return data.team;
  }

  function sanitizeTeam(team) {
    // Sunucuya gereksiz UI alanlarını gönderme; skill + kadro yeterli
    const copyPlayer = (p) => ({
      id: p.id,
      name: p.name,
      number: p.number,
      pos: p.pos,
      naturalPos: p.naturalPos || p.pos,
      age: p.age,
      x: p.x,
      y: p.y,
      condition: p.condition,
      injured: !!p.injured,
      injuryDaysLeft: p.injuryDaysLeft || 0,
      sentOff: !!p.sentOff,
      cards: p.cards || 0,
      minutesPlayed: p.minutesPlayed || 0,
      goals: p.goals || 0,
      assists: p.assists || 0,
      saves: p.saves || 0,
      passing: p.passing,
      finishing: p.finishing,
      pace: p.pace,
      technique: p.technique,
      positioning: p.positioning,
      tackle: p.tackle,
      stamina: p.stamina,
      strength: p.strength,
      agility: p.agility,
      vision: p.vision,
      dribbling: p.dribbling,
      reflex: p.reflex,
      handling: p.handling,
    });
    return {
      name: team.name,
      players: (team.players || []).map(copyPlayer),
      bench: (team.bench || []).map(copyPlayer),
      gameStyle: team.gameStyle || "dengeli",
      passStyle: team.passStyle || "kısa",
      attackDir: team.attackDir || "orta",
      customTactics: team.customTactics || {},
      matchBonuses: team.matchBonuses || {
        attack: 0,
        midfield: 0,
        defense: 0,
        gk: 0,
      },
      currentFormation: team.currentFormation || "4-4-2",
      subsMax: team.subsMax || 5,
      subsUsed: 0,
    };
  }

  // ---------------- Socket ----------------
  function connectSocket() {
    if (!authToken) throw new Error("Önce giriş yap (token yok).");
    if (typeof io === "undefined") {
      throw new Error("socket.io yüklenmedi (cdn script ekle).");
    }
    if (socket && socket.connected) return socket;

    socket = io(API_BASE, {
      auth: { token: authToken },
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      setStatus("🟢 Sunucuya bağlandı");
      console.log("[EM] socket connected", socket.id);
    });

    socket.on("connect_error", (err) => {
      setStatus("🔴 Bağlantı hatası: " + (err.message || err));
      console.warn("[EM] connect_error", err);
    });

    socket.on("queue:waiting", () => {
      setStatus("🔎 Rakip aranıyor…");
    });

    socket.on("match:found", (info) => {
      currentMatchId = info.matchId;
      onlineActive = true;
      stopLocalSimulation();
      setStatus(
        "⚔️ Rakip bulundu: " +
          (info.home && info.home.username) +
          " vs " +
          (info.away && info.away.username),
      );
      if (typeof addLog === "function") {
        addLog(
          "Online maç: " +
            (info.home && info.home.username) +
            " — " +
            (info.away && info.away.username),
          "tactics-log",
        );
      }
    });

    socket.on("match:countdown", (n) => {
      setStatus("⏳ Maç başlıyor: " + n);
      const cd = document.getElementById("countdownDisplay");
      if (cd) cd.innerText = String(n);
    });

    socket.on("match:state", (state) => {
      applyMatchState(state);
    });

    socket.on("match:log", (entry) => {
      if (typeof addLog === "function") {
        const min = entry.minute != null ? entry.minute + "' " : "";
        addLog(min + (entry.text || entry.message || ""), "tactics-log");
      }
    });

    socket.on("match:ended", (state) => {
      onlineActive = false;
      if (state) applyMatchState(state);
      setStatus("🏁 Maç bitti!");
      if (typeof matchEnded !== "undefined") {
        try {
          // global flag
        } catch (e) {}
      }
      // global matchEnded if exists
      try {
        if (typeof matchEnded !== "undefined") {
          // eslint-disable-next-line no-global-assign
        }
      } catch (e) {}
      if (typeof window !== "undefined") {
        window.__emMatchEnded = true;
      }
      try {
        // index.html değişkeni
        if (typeof matchEnded !== "undefined") {
          // assigned below via indirect
        }
      } catch (e) {}
      finalizeOnlineMatch(state);
    });

    socket.on("match:substitutionResult", (result) => {
      if (result && result.error) {
        setStatus("Değişiklik: " + result.error);
      } else if (result && result.ok) {
        setStatus("Değişiklik uygulandı");
      }
    });

    return socket;
  }

  function stopLocalSimulation() {
    try {
      if (typeof matchInterval !== "undefined" && matchInterval) {
        clearInterval(matchInterval);
        matchInterval = null;
      }
      if (typeof circulationInterval !== "undefined" && circulationInterval) {
        clearInterval(circulationInterval);
        circulationInterval = null;
      }
    } catch (e) {
      console.warn(e);
    }
  }

  function applyMatchState(state) {
    if (!state) return;
    stopLocalSimulation();

    // Dakika / skor
    try {
      if (typeof matchMinute !== "undefined") {
        // can't assign const; use window bridge
      }
    } catch (e) {}
    window.__emState = state;

    const homeName =
      (state.players && state.players.home && state.players.home.username) ||
      (state.homeName) ||
      "Ev";
    const awayName =
      (state.players && state.players.away && state.players.away.username) ||
      (state.awayName) ||
      "Dep";
    const hs = (state.score && state.score.home) || 0;
    const as = (state.score && state.score.away) || 0;
    const min = state.minute != null ? state.minute : 0;
    const minStr = min < 10 ? "0" + min : String(min);

    const sb = document.getElementById("scoreBoard");
    if (sb) {
      sb.innerText =
        minStr + ":00 - " + homeName + " " + hs + " - " + as + " " + awayName;
    }
    const timer = document.getElementById("matchTimerDisplay");
    if (timer) timer.innerHTML = "⏱️ " + minStr + ":00";

    setStatus(
      min + "'  " + homeName + " " + hs + " - " + as + " " + awayName,
    );

    // İstatistik
    if (state.stats && typeof stats !== "undefined") {
      try {
        if (state.stats.home) {
          stats.home.shots = state.stats.home.shots || 0;
          stats.home.onTarget = state.stats.home.onTarget || 0;
          stats.home.goals = state.stats.home.goals != null ? state.stats.home.goals : hs;
          if (state.stats.home.possession != null)
            stats.home.possession = state.stats.home.possession;
        }
        if (state.stats.away) {
          stats.away.shots = state.stats.away.shots || 0;
          stats.away.onTarget = state.stats.away.onTarget || 0;
          stats.away.goals = state.stats.away.goals != null ? state.stats.away.goals : as;
          if (state.stats.away.possession != null)
            stats.away.possession = state.stats.away.possession;
        }
        if (typeof updateStatsDisplay === "function") updateStatsDisplay();
      } catch (e) {
        console.warn("[EM] stats", e);
      }
    }

    // Skor global
    try {
      if (typeof homeScore !== "undefined") {
        window.homeScore = hs;
      }
    } catch (e) {}
  }

  function finalizeOnlineMatch(state) {
    stopLocalSimulation();
    const startBtn = document.getElementById("startMatchBtn");
    if (startBtn) startBtn.disabled = false;
    if (typeof addLog === "function") {
      const hs = (state && state.score && state.score.home) || 0;
      const as = (state && state.score && state.score.away) || 0;
      addLog("90' Online maç bitti! " + hs + " - " + as, "match-end");
    }
  }

  function setStatus(text) {
    const el = document.getElementById("matchStatus");
    if (el) el.innerText = text;
  }

  // ---------------- Queue / match actions ----------------
  async function joinOnlineQueue() {
    if (!authToken) throw new Error("Token yok — önce loginAccount");
    await syncTeamToServer();
    connectSocket();
    onlineActive = true;
    stopLocalSimulation();
    setStatus("🔎 Kadro gönderildi, rakip aranıyor…");
    socket.emit("queue:join");
  }

  function leaveQueue() {
    if (socket) socket.emit("queue:leave");
    setStatus("Kuyruktan çıkıldı");
  }

  function sendTacticChange(tactics) {
    if (!socket || !currentMatchId) return;
    socket.emit("match:tacticChange", {
      matchId: currentMatchId,
      tactics: tactics || {},
    });
  }

  function sendSubstitution(outIdx, inIdx) {
    if (!socket || !currentMatchId) return;
    socket.emit("match:substitution", {
      matchId: currentMatchId,
      outIdx,
      inIdx,
    });
  }

  /**
   * index.html startCountdown / startMatch yerine çağrılır.
   * ONLINE modda local tick BAŞLATILMAZ.
   */
  async function startOnlineMatchFlow() {
    try {
      const btn = document.getElementById("startMatchBtn");
      if (btn) btn.disabled = true;
      setStatus("🌐 Online maça bağlanılıyor…");
      await joinOnlineQueue();
    } catch (err) {
      console.error(err);
      setStatus("Hata: " + (err.message || err));
      const btn = document.getElementById("startMatchBtn");
      if (btn) btn.disabled = false;
    }
  }

  /** index.html kancası: Maçı Başlat butonunu online'a çevir */
  function installHooks() {
    const online =
      global.EM_ONLINE === true ||
      localStorage.getItem("em_online") === "1";

    if (!online) {
      console.log("[EM] Offline mod — local maç motoru açık");
      return;
    }

    console.log("[EM] ONLINE mod — local tick kapatılacak");

    // startCountdown override
    const prevStartCountdown = global.startCountdown;
    global.startCountdown = function () {
      startOnlineMatchFlow();
    };

    // startMatch override (başka yerden çağrılırsa)
    const prevStartMatch = global.startMatch;
    global.startMatch = function () {
      // Local interval ASLA kurma
      stopLocalSimulation();
      startOnlineMatchFlow();
    };

    // runMatchTick no-op safety
    if (typeof global.runMatchTick === "function") {
      const prevTick = global.runMatchTick;
      global.runMatchTick = function () {
        if (onlineActive || currentMatchId) {
          stopLocalSimulation();
          return; // sunucu yönetiyor
        }
        return prevTick.apply(this, arguments);
      };
    }

    // In-match tactics → sunucu
    const applyBtn = document.getElementById("inmatchApplyTacticsBtn");
    if (applyBtn) {
      applyBtn.addEventListener(
        "click",
        function () {
          if (!currentMatchId) return;
          sendTacticChange({
            passStyle: document.getElementById("inmatchPassStyle")?.value,
            gameStyle: document.getElementById("inmatchGameStyle")?.value,
            attackDir: document.getElementById("inmatchAttackDir")?.value,
          });
        },
        true,
      );
    }

    const subBtn = document.getElementById("inmatchSubBtn");
    if (subBtn) {
      subBtn.addEventListener(
        "click",
        function () {
          if (!currentMatchId) return;
          const outIdx = parseInt(
            document.getElementById("inmatchOutSelect")?.value,
            10,
          );
          const inIdx = parseInt(
            document.getElementById("inmatchInSelect")?.value,
            10,
          );
          if (!isNaN(outIdx) && !isNaN(inIdx)) sendSubstitution(outIdx, inIdx);
        },
        true,
      );
    }

    setStatus("🌐 Online hazır — Maçı Başlat = rakip ara");
  }

  // Public API
  global.EM = {
    API_BASE,
    registerAccount,
    loginAccount,
    syncTeamToServer,
    loadTeamFromServer,
    connectSocket,
    joinOnlineQueue,
    leaveQueue,
    sendTacticChange,
    sendSubstitution,
    startOnlineMatchFlow,
    installHooks,
    stopLocalSimulation,
    get socket() {
      return socket;
    },
    get matchId() {
      return currentMatchId;
    },
    get token() {
      return authToken;
    },
  };

  // DOM hazırsa otomatik kur
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(installHooks, 50);
    });
  } else {
    setTimeout(installHooks, 50);
  }
})(typeof window !== "undefined" ? window : globalThis);
