// ============================================================
// multiplayer-client.js — Zamanlanmış lig (CLIENT)
// ------------------------------------------------------------
// - "Maçı Başlat" YOK. Fikstür saatinde maç sunucuda başlar.
// - Taktik/kadro: maç saatinden önce istediğin zaman kaydet.
// - Kimse online olmasa da maç son taktikle oynanır → lige işlenir.
// - Online isen canlı skor/log izlersin.
//
//   window.EM_ONLINE = true;
//   window.EM_API_BASE = "https://...";
// ============================================================

(function (global) {
  "use strict";

  const API_BASE =
    global.EM_API_BASE ||
    localStorage.getItem("em_api_base") ||
    "https://elite-manager-online.onrender.com";

  let socket = null;
  let authToken = localStorage.getItem("em_token") || null;
  let currentMatchId = null;
  let currentFixtureId = null;
  let onlineActive = false;
  let pollTimer = null;
  let countdownTimer = null;

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

  async function registerAccount(username, password, teamName) {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, teamName }),
    });
    authToken = data.token;
    localStorage.setItem("em_token", data.token);
    if (data.user?.username) localStorage.setItem("em_username", data.user.username);
    return data;
  }

  async function loginAccount(username, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    authToken = data.token;
    localStorage.setItem("em_token", data.token);
    if (data.user?.username) localStorage.setItem("em_username", data.user.username);
    return data;
  }

  async function ensureOnlineAuth() {
    if (authToken) return authToken;
    let baseName = null;
    try {
      if (typeof currentUser !== "undefined" && currentUser) baseName = String(currentUser);
    } catch (e) {}
    try {
      if (!baseName) baseName = localStorage.getItem("em_username") || localStorage.getItem("username");
    } catch (e) {}
    const password = "online-" + (baseName || "guest") + "-em2024";
    if (baseName && baseName.length >= 2) {
      try {
        await loginAccount(baseName, password);
        return authToken;
      } catch (e) {
        try {
          await registerAccount(baseName, password, baseName + " SK");
          return authToken;
        } catch (e2) {}
      }
    }
    const guest = "guest_" + Math.random().toString(36).slice(2, 8);
    await registerAccount(guest, "guest-pass-123456", guest + " SK");
    return authToken;
  }

  function sanitizeTeam(team) {
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
    };
  }

  /** Taktik + kadroyu sunucuya kaydet (maç saatinden önce) */
  async function syncTeamToServer() {
    if (typeof teamConfig === "undefined" || !teamConfig.home) {
      console.warn("[EM] teamConfig.home yok");
      return null;
    }
    const team = sanitizeTeam(teamConfig.home);
    await api("/api/team", { method: "POST", body: JSON.stringify({ team }) });
    setStatus("💾 Taktikler sunucuya kaydedildi");
    return team;
  }

  function connectSocket() {
    if (!authToken) throw new Error("Token yok");
    if (typeof io === "undefined") throw new Error("socket.io yok");
    if (socket && socket.connected) return socket;

    socket = io(API_BASE, {
      auth: { token: authToken },
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      console.log("[EM] socket connected");
      if (currentFixtureId) socket.emit("fixture:watch", { fixtureId: currentFixtureId });
    });

    socket.on("connect_error", (err) => {
      setStatus("🔴 " + (err.message || err));
    });

    socket.on("club:info", (info) => {
      if (info.club) {
        window.__emClubId = info.club.id;
        window.__emClubName = info.club.name;
      }
      if (info.nextFixture) onNextFixture(info.nextFixture);
    });

    socket.on("fixture:live", (info) => {
      currentFixtureId = info.fixtureId;
      currentMatchId = info.matchId;
      onlineActive = true;
      stopLocalSimulation();
      hideStartButton();
      setStatus("🔴 CANLI maç başladı!");
      if (typeof addLog === "function") addLog("Canlı maç yayını bağlandı", "tactics-log");
    });

    socket.on("fixture:finished", (info) => {
      onlineActive = false;
      setStatus(
        "🏁 Maç bitti " +
          (info.score ? info.score.home + "-" + info.score.away : ""),
      );
      currentMatchId = null;
      try {
        showOnlineMatchSummary(info);
      } catch (e) {
        console.warn(e);
      }
      renderOnlineStandings().catch(() => {});
      setTimeout(refreshNextFixture, 1500);
    });

    socket.on("fixtures:update", () => {
      refreshNextFixture();
    });

    socket.on("match:state", applyMatchState);
    socket.on("match:log", (entry) => {
      if (typeof addLog === "function") {
        const min = entry.minute != null ? entry.minute + "' " : "";
        addLog(min + (entry.text || ""), "tactics-log");
      }
    });
    socket.on("match:goal", (g) => {
      if (typeof addLog === "function") {
        addLog(
          "⚽ GOL! " + (g.scorer || "") + " " + g.score.home + "-" + g.score.away,
          "goal",
        );
      }
      try {
        if (typeof playGoalSound === "function") playGoalSound();
      } catch (e) {}
    });
    socket.on("match:ended", (state) => {
      if (state) applyMatchState(state);
      setStatus("🏁 Maç bitti!");
      onlineActive = false;
      try {
        showOnlineMatchSummary(state);
      } catch (e) {}
    });
    socket.on("match:substitutionResult", (r) => {
      if (r?.error) setStatus("Değişiklik: " + r.error);
      else if (r?.ok) setStatus("Değişiklik OK");
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
      if (typeof countdownInterval !== "undefined" && countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    } catch (e) {}
  }

  function hideStartButton() {
    const btn = document.getElementById("startMatchBtn");
    if (btn) {
      btn.style.display = "none";
      btn.disabled = true;
    }
    const note = document.getElementById("prematch-note");
    if (note) {
      note.innerText =
        "Maç fikstür saatinde otomatik başlar. Taktiklerini kaydetmen yeterli — oyunda olmasan da maç oynanır.";
    }
  }

  function applyMatchState(state) {
    if (!state) return;
    stopLocalSimulation();
    window.__emState = state;
    onlineActive = state.status === "live";

    const homeName =
      state.players?.home?.teamName || state.players?.home?.username || "Ev";
    const awayName =
      state.players?.away?.teamName || state.players?.away?.username || "Dep";
    const hs = state.score?.home || 0;
    const as = state.score?.away || 0;
    const min = state.minute != null ? state.minute : 0;
    const minStr = min < 10 ? "0" + min : String(min);

    const sb = document.getElementById("scoreBoard");
    if (sb)
      sb.innerText =
        minStr + ":00 - " + homeName + " " + hs + " - " + as + " " + awayName;
    const timer = document.getElementById("matchTimerDisplay");
    if (timer) timer.innerHTML = "⏱️ " + minStr + ":00";
    setStatus(min + "'  " + homeName + " " + hs + " - " + as + " " + awayName);

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
      } catch (e) {}
    }
  }

  function setStatus(text) {
    const el = document.getElementById("matchStatus");
    if (el) el.innerText = text;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "00:00";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0)
      return (
        h +
        ":" +
        String(m).padStart(2, "0") +
        ":" +
        String(sec).padStart(2, "0")
      );
    return String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
  }

  function onNextFixture(fixture) {
    if (!fixture) {
      setStatus("Fikstür yok");
      return;
    }
    currentFixtureId = fixture.id;
    if (socket && socket.connected) {
      socket.emit("fixture:watch", { fixtureId: fixture.id });
    }

    if (fixture.status === "live") {
      currentMatchId = fixture.matchId;
      setStatus("🔴 Maç canlı!");
      hideStartButton();
      return;
    }

    const kick = fixture.kickoffAt;
    const home = fixture.homeName || "Ev";
    const away = fixture.awayName || "Dep";
    const homeTag = fixture.homeIsBot ? " (bot)" : "";
    const awayTag = fixture.awayIsBot ? " (bot)" : "";

    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const left = kick - Date.now();
      if (left <= 0) {
        setStatus("⏳ Maç başlıyor… " + home + " vs " + away);
        hideStartButton();
        clearInterval(countdownTimer);
        return;
      }
      setStatus(
        "📅 Sonraki maç " +
          formatCountdown(left) +
          " — " +
          home +
          homeTag +
          " vs " +
          away +
          awayTag,
      );
    }, 1000);

    const kickDate = new Date(kick);
    const note = document.getElementById("prematch-note");
    if (note) {
      note.innerText =
        "Kickoff: " +
        kickDate.toLocaleString("tr-TR") +
        " · Taktiklerini şimdi kaydet. Oyunda olmasan da maç otomatik oynanır.";
    }
  }

  async function refreshNextFixture() {
    try {
      const data = await api("/api/fixtures/next");
      if (data.fixture) onNextFixture(data.fixture);
      else setStatus("Bu sezon için bekleyen maç yok");
    } catch (e) {
      console.warn("[EM] next fixture", e);
    }
  }

  async function loadStandings() {
    try {
      return await api("/api/league/standings");
    } catch (e) {
      return null;
    }
  }

  /** Lig sayfasındaki standingsBody tablosunu doldur */
  async function renderOnlineStandings() {
    const data = await loadStandings();
    if (!data || !data.standings) return data;
    const tbody = document.getElementById("standingsBody");
    const table = tbody ? tbody.closest("table") : null;
    if (table) table.style.display = "";
    if (tbody) {
      const myClub = window.__emClubId || null;
      tbody.innerHTML = data.standings
        .map((r, i) => {
          const isMe = myClub && r.clubId === myClub;
          const bot = r.isBot ? ' <span style="color:#64748b;font-size:10px">bot</span>' : "";
          return (
            "<tr" +
            (isMe ? ' class="user-team-row"' : "") +
            "><td>" +
            (i + 1) +
            "</td><td>" +
            (r.name || "?") +
            bot +
            "</td><td>" +
            r.played +
            "</td><td>" +
            r.w +
            "</td><td>" +
            r.d +
            "</td><td>" +
            r.l +
            "</td><td>" +
            (r.gd >= 0 ? "+" : "") +
            r.gd +
            "</td><td><b>" +
            r.pts +
            "</b></td></tr>"
          );
        })
        .join("");
    }
    // Haftayı Oynat gizle — online'da yok
    const pr = document.getElementById("playRoundBtn");
    if (pr) pr.style.display = "none";
    return data;
  }

  function showOnlineMatchSummary(payload) {
    const state = payload || window.__emState || {};
    const hs = (state.score && state.score.home) != null ? state.score.home : payload?.score?.home || 0;
    const as = (state.score && state.score.away) != null ? state.score.away : payload?.score?.away || 0;
    const home =
      payload?.homeName ||
      state.players?.home?.teamName ||
      state.players?.home?.username ||
      "Ev";
    const away =
      payload?.awayName ||
      state.players?.away?.teamName ||
      state.players?.away?.username ||
      "Dep";

    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    };
    set("msScore", hs + " - " + as);
    set("msTeams", home + "  —  " + away);

    let resultText = "Beraberlik";
    let resultColor = "#facc15";
    // Kullanıcı tarafı galibiyet/mağlubiyet
    const myClub = window.__emClubName || "";
    if (hs > as) {
      resultText = "Galibiyet · " + home;
      resultColor = "#4ade80";
    } else if (as > hs) {
      resultText = "Galibiyet · " + away;
      resultColor = "#4ade80";
    }
    if (myClub) {
      if ((hs > as && home === myClub) || (as > hs && away === myClub)) {
        resultText = "Galibiyet";
        resultColor = "#4ade80";
      } else if ((hs < as && home === myClub) || (as < hs && away === myClub)) {
        resultText = "Mağlubiyet";
        resultColor = "#f87171";
      } else if (hs === as) {
        resultText = "Beraberlik";
        resultColor = "#facc15";
      }
    }
    const res = document.getElementById("msResult");
    if (res) {
      res.innerText = resultText;
      res.style.color = resultColor;
    }

    const stats = state.stats || payload?.stats || {};
    set("msHomeShots", (stats.home && stats.home.shots) || 0);
    set("msAwayShots", (stats.away && stats.away.shots) || 0);
    set("msHomeOnT", (stats.home && stats.home.onTarget) || 0);
    set("msAwayOnT", (stats.away && stats.away.onTarget) || 0);
    set(
      "msHomePoss",
      ((stats.home && stats.home.possession) != null ? stats.home.possession : 50) + "%",
    );
    set(
      "msAwayPoss",
      ((stats.away && stats.away.possession) != null ? stats.away.possession : 50) + "%",
    );

    const scorers = state.scorers || payload?.scorers || [];
    const scEl = document.getElementById("msScorers");
    if (scEl) {
      if (!scorers.length) scEl.innerText = "Gol yok";
      else {
        scEl.innerHTML = scorers
          .map(
            (s) =>
              "<div><b style='color:#e2e8f0'>" +
              s.minute +
              "'</b> " +
              (s.name || "") +
              (s.assist ? " <span style='color:#94a3b8'>(Asist: " + s.assist + ")</span>" : "") +
              " <span style='color:#64748b'>(" +
              (s.team || s.side || "") +
              ")</span></div>",
          )
          .join("");
      }
    }

    const note = document.getElementById("msLeagueNote");
    if (note) note.innerText = "Sonuç online lige işlendi.";

    const ov = document.getElementById("matchSummaryOverlay");
    if (ov) ov.classList.add("active");
    // Puan tablosunu yenile
    renderOnlineStandings().catch(() => {});
  }

  function sendTacticChange(tactics) {
    if (!socket || !currentMatchId) return;
    socket.emit("match:tacticChange", { matchId: currentMatchId, tactics: tactics || {} });
  }

  function sendSubstitution(outIdx, inIdx) {
    if (!socket || !currentMatchId) return;
    socket.emit("match:substitution", { matchId: currentMatchId, outIdx, inIdx });
  }

  /**
   * Online mod kurulumu:
   * - Start butonunu gizle / no-op
   * - Auth + takım senkron + sonraki maç sayacı
   * - Periyodik taktik kaydı (değişiklikleri sunucuya yazar)
   */
  async function bootOnline() {
    hideStartButton();
    setStatus("🌐 Online lig bağlanıyor…");
    try {
      await ensureOnlineAuth();
      try {
        await syncTeamToServer();
      } catch (e) {
        console.warn("[EM] ilk senkron", e.message || e);
      }
      connectSocket();
      await refreshNextFixture();
      await renderOnlineStandings();

      // Taktik değişikliklerini aralıklı kaydet (maç öncesi)
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (onlineActive) return; // canlıda kadro API kilitli
        syncTeamToServer().catch(() => {});
      }, 45000);

      setStatus("🌐 Lig hazır — taktik kaydet, maç saatinde otomatik başlar");
    } catch (err) {
      console.error(err);
      setStatus("Hata: " + (err.message || err));
    }
  }

  function installHooks() {
    const online =
      global.EM_ONLINE === true || localStorage.getItem("em_online") === "1";
    if (!online) {
      console.log("[EM] Offline — local motor");
      return;
    }
    console.log("[EM] ONLINE zamanlanmış lig modu");

    // Maçı Başlat = hiçbir şey (veya sadece senkron hatırlat)
    global.startCountdown = function () {
      setStatus("Maç saati gelince otomatik başlar. Taktiklerini kaydet.");
      syncTeamToServer().catch(() => {});
    };
    global.startMatch = function () {
      stopLocalSimulation();
      setStatus("Maç saati gelince otomatik başlar.");
    };
    if (typeof global.runMatchTick === "function") {
      const prev = global.runMatchTick;
      global.runMatchTick = function () {
        if (onlineActive || currentMatchId) {
          stopLocalSimulation();
          return;
        }
        return prev.apply(this, arguments);
      };
    }

    // Maç içi paneller
    const applyBtn = document.getElementById("inmatchApplyTacticsBtn");
    if (applyBtn) {
      applyBtn.addEventListener(
        "click",
        function () {
          if (!currentMatchId) {
            // Maç öncesi: sunucuya kaydet
            syncTeamToServer().catch(() => {});
            return;
          }
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
          const outIdx = parseInt(document.getElementById("inmatchOutSelect")?.value, 10);
          const inIdx = parseInt(document.getElementById("inmatchInSelect")?.value, 10);
          if (!isNaN(outIdx) && !isNaN(inIdx)) sendSubstitution(outIdx, inIdx);
        },
        true,
      );
    }

    // "Taktik kaydet" yardımcı butonu (yoksa start butonunu dönüştür)
    const startBtn = document.getElementById("startMatchBtn");
    if (startBtn) {
      startBtn.style.display = "";
      startBtn.disabled = false;
      startBtn.innerText = "💾 Taktikleri Kaydet";
      startBtn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        syncTeamToServer()
          .then(() => setStatus("💾 Kaydedildi — maç saatinde otomatik oynanır"))
          .catch((err) => setStatus("Kayıt hatası: " + err.message));
        return false;
      };
    }

    bootOnline();
  }

  global.EM = {
    API_BASE,
    registerAccount,
    loginAccount,
    ensureOnlineAuth,
    syncTeamToServer,
    connectSocket,
    sendTacticChange,
    sendSubstitution,
    refreshNextFixture,
    loadStandings,
    renderOnlineStandings,
    showOnlineMatchSummary,
    installHooks,
    stopLocalSimulation,
    get socket() {
      return socket;
    },
    get matchId() {
      return currentMatchId;
    },
    get fixtureId() {
      return currentFixtureId;
    },
    get token() {
      return authToken;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(installHooks, 80);
    });
  } else {
    setTimeout(installHooks, 80);
  }
})(typeof window !== "undefined" ? window : globalThis);
