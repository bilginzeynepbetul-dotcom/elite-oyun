// ============================================================
// multiplayer-client.js — index.html'i gerçek backend'e bağlar
// ------------------------------------------------------------
// KAPSAM (Faz 1+2):
//  - Kayıt / Giriş → /api/auth/register, /api/auth/login (JWT)
//  - Takım / kadro senkronu → GET+POST /api/team
//  - Kasa / gelir-gider → GET /api/economy
//  - Puan durumu → GET /api/league/standings
//  - Fikstür (sıradaki maç + tüm liste) → /api/fixtures, /api/fixtures/next
//  - Canlı maç izleme (skor/istatistik/log) → socket.io (match:state,
//    match:goal, match:log, match:ended, fixture:live)
//
// KAPSAM DIŞI (backend'de henüz endpoint yok, client-local kalmaya devam
// ediyor): transfer piyasası, antrenman, altyapı/akademi, stadyum, forum,
// mesajlar/bildirimler, sahada oyuncu x/y canlı animasyonu (server sadece
// skor/istatistik/log yayınlıyor, top/oyuncu koordinatı yayınlamıyor).
//
// index.html'deki tüm fonksiyonlar/değişkenler (teamConfig, worldLeagues,
// addLog, switchPage, vb.) klasik <script> olduğu için bu dosyadan da
// doğrudan erişilebilir — ayrı bir modül/import gerekmiyor.
// ============================================================

(function () {
  const API_BASE = window.EM_API_BASE || "";
  const TOKEN_KEY = "em_jwt_token";
  const CLUB_KEY = "em_club_info";
  let socket = null;
  let _emNextFixture = null;
  let _emMyClub = null;
  let _emPlayerIdCounter = 1;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {},
    );
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    const res = await fetch(
      API_BASE + path,
      Object.assign({}, opts, { headers }),
    );
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
    return data;
  }

  // ------------------------------------------------------------
  // Sunucu oyuncu objesini client'ın beklediği alanlarla tamamla
  // (backend teamUtils.js/matchEngine.js aynı skill isimlerini
  // kullanıyor: passing, finishing, pace, technique, positioning,
  // tackle, stamina, strength, agility, vision, reflex, condition —
  // eksik olan sadece client-only kozmetik alanlar).
  // ------------------------------------------------------------
  function normalizeServerPlayer(p, idx, isStarter) {
    if (!p) return p;
    p.id = p.id || "srv_" + _emPlayerIdCounter++;
    p.naturalPos = p.naturalPos || p.pos;
    p.age = p.age || 18 + Math.floor(Math.random() * 12);
    p.form = p.form != null ? p.form : 0;
    p.experience = p.experience != null ? p.experience : 3;
    p.happiness = p.happiness != null ? p.happiness : 80;
    p.minutesPlayed = isStarter ? 90 : 0;
    p.keyActions = p.keyActions || 0;
    p.baseQuality = p.baseQuality || Math.round(3 + Math.random() * 7);
    p.basePotential = p.basePotential || Math.round(3 + Math.random() * 7);
    if (isStarter) {
      try {
        const slots = getHomePositions();
        const slot = slots[idx] || slots[slots.length - 1];
        p.x = slot.x;
        p.y = slot.y;
      } catch (e) {
        p.x = 300;
        p.y = 200;
      }
    } else {
      p.x = p.x || 300;
      p.y = p.y || 200;
    }
    return p;
  }

  function applyServerTeamToClient(serverTeam) {
    if (!serverTeam || typeof teamConfig === "undefined") return;
    teamConfig.home.name = serverTeam.name || teamConfig.home.name;
    teamConfig.home.players = (serverTeam.players || []).map((p, i) =>
      normalizeServerPlayer(p, i, true),
    );
    teamConfig.home.bench = (serverTeam.bench || []).map((p, i) =>
      normalizeServerPlayer(p, i, false),
    );
    teamConfig.home.gameStyle = serverTeam.gameStyle || teamConfig.home.gameStyle;
    teamConfig.home.passStyle = serverTeam.passStyle || teamConfig.home.passStyle;
    teamConfig.home.attackDir = serverTeam.attackDir || teamConfig.home.attackDir;
    teamConfig.home.subsUsed = 0;
    teamConfig.home.subsMax = 5;
    teamConfig.home.currentFormation = teamConfig.home.currentFormation || "4-4-2";
    try {
      normalizePlayerPositions(teamConfig.home);
    } catch (e) {}
    try {
      renderSquadRosterPage("home");
    } catch (e) {}
    try {
      renderFormationPitch("home");
      renderFormationBench("home");
    } catch (e) {}
    try {
      updateMenuClubNat();
    } catch (e) {}
  }

  function applyServerEconomyToClient(eco) {
    if (typeof clubBudget === "undefined" || !eco) return;
    clubBudget = eco.balance || 0;
    financeLedger.length = 0;
    (eco.ledger || [])
      .slice()
      .reverse()
      .forEach((l) =>
        financeLedger.unshift({
          type: (l.amount || 0) >= 0 ? "gelir" : "gider",
          label: l.label,
          amount: l.amount,
          at: l.ts,
        }),
      );
    try {
      updateBudgetUI();
    } catch (e) {}
  }

  function applyServerStandingsToClient(rows) {
    if (typeof worldLeagues === "undefined" || !worldLeagues[USER_COUNTRY])
      return;
    const mapped = (rows || []).map((r) => ({
      name: r.name,
      strength: 70,
      played: r.played,
      won: r.w,
      drawn: r.d,
      lost: r.l,
      gf: r.gf,
      ga: r.ga,
      pts: r.pts,
      isUserTeam: !!r.userId,
      clubId: r.clubId,
      players: r.userId ? teamConfig.home.players : undefined,
    }));
    worldLeagues[USER_COUNTRY][USER_DIVISION] = mapped;
    try {
      renderStandings();
    } catch (e) {}
  }

  async function refreshNextMatchFromServer() {
    const data = await apiFetch("/api/fixtures/next");
    _emNextFixture = data.fixture;
    _emMyClub = data.club;
    const title = document.getElementById("nextMatchTitle");
    const meta = document.getElementById("nextMatchMeta");
    const btn = document.getElementById("nextMatchPlayBtn");
    if (!title || !meta || !btn) return;
    if (_emNextFixture) {
      const f = _emNextFixture;
      const isHome = _emMyClub && f.homeClubId === _emMyClub.id;
      const opp = isHome ? f.awayName : f.homeName;
      title.innerText = teamConfig.home.name + (isHome ? " vs " : " @ ") + opp;
      const when = new Date(f.kickoffAt).toLocaleString("tr-TR", {
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
      });
      meta.innerText =
        (isHome ? "İç saha" : "Deplasman") +
        " · " +
        when +
        (f.status === "live" ? " · CANLI" : "");
      btn.innerText = f.status === "live" ? "📡 Canlı İzle" : "📡 Maçı İzle";
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.onclick = function (e) {
        if (e) e.stopPropagation();
        watchFixture(f.id);
      };
    } else {
      title.innerText = "Fikstür yok";
      meta.innerText = "Lig fikstürü henüz oluşmadı.";
      btn.innerText = "—";
      btn.disabled = true;
    }
  }

  async function syncAllFromServer() {
    try {
      const t = await apiFetch("/api/team");
      if (t && t.team) applyServerTeamToClient(t.team);
    } catch (e) {
      console.warn("[em] team sync", e);
    }
    try {
      const eco = await apiFetch("/api/economy");
      applyServerEconomyToClient(eco);
    } catch (e) {
      console.warn("[em] economy sync", e);
    }
    try {
      const st = await apiFetch("/api/league/standings");
      applyServerStandingsToClient(st.standings || []);
    } catch (e) {
      console.warn("[em] standings sync", e);
    }
    try {
      await refreshNextMatchFromServer();
    } catch (e) {
      console.warn("[em] fixture sync", e);
    }
  }

  // ------------------------------------------------------------
  // Socket.io — canlı maç izleme
  // ------------------------------------------------------------
  function connectSocket() {
    if (typeof io === "undefined") {
      console.warn("[em] socket.io client yüklenmedi");
      return;
    }
    if (socket) socket.disconnect();
    socket = io(API_BASE, { auth: { token: getToken() } });

    socket.on("connect_error", (err) => {
      console.warn("[em] socket bağlantı hatası:", err.message);
    });

    socket.on("fixture:live", () => {
      try {
        addLog("📡 Maç canlı yayında.", "tactics-log");
      } catch (e) {}
    });

    socket.on("match:state", (state) => {
      renderServerMatchState(state);
    });

    socket.on("match:goal", (d) => {
      try {
        addLog(
          "⚽ GOL! " + d.scorer + (d.assist ? " (Asist: " + d.assist + ")" : ""),
          "goal",
        );
      } catch (e) {}
    });

    socket.on("match:log", (d) => {
      try {
        addLog(d.minute + "' " + d.text, "tactics-log");
      } catch (e) {}
    });

    socket.on("match:ended", async (state) => {
      try {
        addLog(
          "🏁 Maç bitti: " + state.score.home + " - " + state.score.away,
          "match-end",
        );
        const status = document.getElementById("matchStatus");
        if (status) status.innerText = "🏁 Maç bitti";
      } catch (e) {}
      await syncAllFromServer();
    });
  }

  function renderServerMatchState(state) {
    if (!state || !state.score || !state.stats) return;
    const minStr = String(state.minute).padStart(2, "0");
    const homeName = (state.players && state.players.home.teamName) || teamConfig.home.name;
    const awayName = (state.players && state.players.away.teamName) || "Rakip";
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    };
    const sb = document.getElementById("scoreBoard");
    if (sb)
      sb.innerText =
        minStr + ":00 - " + homeName + " " + state.score.home + " - " + state.score.away + " " + awayName;
    set("homeShots", state.stats.home.shots);
    set("awayShots", state.stats.away.shots);
    set("homeOnTarget", state.stats.home.onTarget);
    set("awayOnTarget", state.stats.away.onTarget);
    set("homeGoals", state.stats.home.goals);
    set("awayGoals", state.stats.away.goals);
    set("homePossession", Math.round(state.stats.home.possession) + "%");
    set("awayPossession", Math.round(state.stats.away.possession) + "%");
    const fill = document.getElementById("possessionFill");
    if (fill) fill.style.width = Math.round(state.stats.home.possession) + "%";
    const timer = document.getElementById("matchTimerDisplay");
    if (timer) timer.innerHTML = "⏱️ " + minStr + ":00";
    if (state.status === "ended") {
      const status = document.getElementById("matchStatus");
      if (status) status.innerText = "🏁 Maç bitti";
    }
  }

  function watchFixture(fixtureId) {
    if (!socket) connectSocket();
    try {
      hideMainMenuAndShowBack();
      switchPage("page-match");
      resetMatchEngineState();
    } catch (e) {}
    matchStarted = true; // lokal simülasyon kilitli — sunucu yönetiyor
    const startBtn = document.getElementById("startMatchBtn");
    if (startBtn) startBtn.style.display = "none";
    const status = document.getElementById("matchStatus");
    if (status) status.innerText = "📡 Sunucudan canlı izleniyor / bekleniyor...";
    if (socket) socket.emit("fixture:watch", { fixtureId });
    window._emWatchingFixtureId = fixtureId;
  }
  window.watchFixture = watchFixture;

  // Ana menü "Maçı Oyna" / "Sıradaki Maç" akışlarını sunucuya yönlendir
  window.playNextScheduledMatch = function () {
    if (_emNextFixture) watchFixture(_emNextFixture.id);
    else refreshNextMatchFromServer().catch(() => {});
  };
  window.playFixtureMatch = function () {
    if (_emNextFixture) watchFixture(_emNextFixture.id);
    else refreshNextMatchFromServer().catch(() => {});
  };
  window.refreshNextMatchCard = function () {
    refreshNextMatchFromServer().catch(() => {});
  };

  // Canlı Maçlar sayfası: sunucudaki tüm fikstür listesi
  async function renderServerLiveMatches() {
    const list = document.getElementById("liveMatchesList");
    if (!list) return;
    list.innerHTML =
      '<div style="color:#64748b;text-align:center;padding:12px;">Yükleniyor...</div>';
    try {
      const data = await apiFetch("/api/fixtures");
      const fixtures = data.fixtures || [];
      if (!fixtures.length) {
        list.innerHTML =
          '<div style="color:#64748b;text-align:center;padding:12px;">Fikstür yok.</div>';
        return;
      }
      list.innerHTML = fixtures
        .map((f) => {
          const badge =
            f.status === "live"
              ? '<span style="color:#f87171;font-weight:800;">● CANLI</span>'
              : '<span style="color:#38bdf8;">Yaklaşan</span>';
          const when = new Date(f.kickoffAt).toLocaleString("tr-TR", {
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
          });
          return (
            '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;">' +
            '<div style="flex:1;min-width:140px;"><div style="font-size:11px;color:#94a3b8;">' +
            when +
            '</div><div style="font-size:13px;color:#e2e8f0;font-weight:700;">' +
            f.homeName +
            " vs " +
            f.awayName +
            '</div><div style="font-size:11px;">' +
            badge +
            "</div></div>" +
            '<button class="sub-btn" style="width:auto;padding:6px 12px;font-size:11px;" onclick="watchFixture(\'' +
            f.id +
            '\')">İzle</button></div>'
          );
        })
        .join("");
    } catch (e) {
      list.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:12px;">Fikstürler alınamadı.</div>';
    }
  }
  window.goToLiveMatches = function () {
    try {
      hideMainMenuAndShowBack();
      switchPage("page-live-matches");
    } catch (e) {}
    renderServerLiveMatches();
  };

  // "Haftayı Oynat" artık anlamsız — sunucu fikstürü otomatik saatinde başlatıyor
  const roundBtn = document.getElementById("playRoundBtn");
  if (roundBtn) roundBtn.style.display = "none";

  // ------------------------------------------------------------
  // Takım/taktik kaydını sunucuya da yaz (kadro değişince)
  // ------------------------------------------------------------
  async function pushTeamToServer() {
    if (!getToken()) return;
    try {
      await apiFetch("/api/team", {
        method: "POST",
        body: JSON.stringify({
          team: {
            name: teamConfig.home.name,
            players: teamConfig.home.players,
            bench: teamConfig.home.bench,
            gameStyle: teamConfig.home.gameStyle,
            passStyle: teamConfig.home.passStyle,
            attackDir: teamConfig.home.attackDir,
          },
        }),
      });
    } catch (e) {
      console.warn("[em] takım sunucuya kaydedilemedi:", e.message);
    }
  }
  const _origSaveCareer = window.saveCareer;
  window.saveCareer = function (showNote) {
    const r = _origSaveCareer ? _origSaveCareer(showNote) : true;
    pushTeamToServer();
    return r;
  };

  // ------------------------------------------------------------
  // Giriş / Kayıt / Oturum
  // ------------------------------------------------------------
  function rewireButton(id, handler) {
    const old = document.getElementById(id);
    if (!old) return null;
    const clone = old.cloneNode(true);
    old.parentNode.replaceChild(clone, old);
    clone.addEventListener("click", handler);
    return clone;
  }

  async function afterServerLogin(data) {
    managerName = data.user.username;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    };
    set("usernameDisplay", managerName);
    set("menuUsername", managerName);
    set("menuAvatar", managerName.charAt(0).toUpperCase());
    set("mgrProfileUsername", managerName);
    set("mgrProfileAvatar", managerName.charAt(0).toUpperCase());
    try {
      loginOverlay.classList.add("hidden");
      showMainMenu();
    } catch (e) {}
    connectSocket();
    await syncAllFromServer();
  }

  async function handleServerLogin() {
    const username = (document.getElementById("loginUsername") || {}).value?.trim();
    const password = (document.getElementById("loginPassword") || {}).value;
    const errorEl = document.getElementById("loginError");
    if (!username || !password) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı ve şifre gerekli.";
      return;
    }
    if (errorEl) errorEl.innerText = "Giriş yapılıyor...";
    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      setToken(data.token);
      localStorage.setItem(CLUB_KEY, JSON.stringify(data.club || null));
      if (errorEl) errorEl.innerText = "";
      await afterServerLogin(data);
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Giriş başarısız.";
    }
  }

  async function handleServerRegister() {
    const username = (document.getElementById("regUsername") || {}).value?.trim();
    const password = (document.getElementById("regPassword") || {}).value;
    const errorEl = document.getElementById("registerError");
    if (!username || !password || password.length < 6) {
      if (errorEl)
        errorEl.innerText = "Kullanıcı adı gir, şifre en az 6 karakter olmalı.";
      return;
    }
    if (errorEl) errorEl.innerText = "Kayıt oluşturuluyor...";
    try {
      const data = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password, teamName: username + " SK" }),
      });
      setToken(data.token);
      localStorage.setItem(CLUB_KEY, JSON.stringify(data.club || null));
      if (errorEl) errorEl.innerText = "";
      await afterServerLogin(data);
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Kayıt başarısız.";
    }
  }

  rewireButton("loginBtn", handleServerLogin);
  rewireButton("registerBtn", handleServerRegister);

  const _origLogout = window.logoutUser;
  window.logoutUser = function () {
    setToken(null);
    localStorage.removeItem(CLUB_KEY);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    try {
      _origLogout();
    } catch (e) {
      try {
        mainMenu.classList.add("hidden");
        backArrow.classList.remove("visible");
        loginOverlay.classList.remove("hidden");
      } catch (e2) {}
    }
  };

  // Sayfa açılışında token varsa otomatik giriş
  async function tryAutoLogin() {
    if (!getToken()) return;
    try {
      const data = await apiFetch("/api/me");
      await afterServerLogin(data);
    } catch (e) {
      console.warn("[em] otomatik giriş başarısız, token temizleniyor:", e.message);
      setToken(null);
    }
  }
  tryAutoLogin();
})();
