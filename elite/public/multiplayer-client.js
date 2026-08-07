// ============================================================
// multiplayer-client.js — index.html'i gerçek backend'e bağlar
// ------------------------------------------------------------
// KAPSAM (Faz 1–3):
//  - Kayıt / Giriş → /api/auth/register, /api/auth/login (JWT)
//  - Takım / kadro senkronu → GET+POST /api/team
//  - Kasa / gelir-gider → GET /api/economy
//  - Puan durumu → GET /api/league/standings
//  - Fikstür (sıradaki maç + tüm liste) → /api/fixtures, /api/fixtures/next
//  - Canlı maç izleme → match:state, match:goal, match:log, match:ended,
//    match:ball, positions
//  - Maç içi taktik / değişiklik → match:tactics, match:sub
//  - Transfer piyasası → /api/transfer/market|bid|list|cancel|refresh
//
//  - Altyapı / akademi → /api/youth, /api/youth/draw, /api/youth/upgrade
//
//  - Antrenman → /api/training, /player, /squad, /coach
//
//  - Stadyum → /api/stadium, /upgrade, /ticket, /rename
//
//  - Forum / mesajlar / bildirimler → /api/forum, /messages, /notifications
//
// KAPSAM DIŞI: (yok — temel online özellikler tamamlandı).
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
  let _emFixtureCache = {}; // fixtureId -> fixture (homeClubId/awayClubId dahil)
  let _emMySide = null; // "home" | "away" | null — izlenen maçta hangi taraftayım
  let _emInmatchPanelShown = false;

  function cacheFixture(f) {
    if (f && f.id) _emFixtureCache[f.id] = f;
  }

  function determineMySide(fixtureId) {
    const f = _emFixtureCache[fixtureId];
    if (!f || !_emMyClub) return null;
    if (f.homeClubId === _emMyClub.id) return "home";
    if (f.awayClubId === _emMyClub.id) return "away";
    return null;
  }
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
    cacheFixture(_emNextFixture);
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
      btn.innerText =
        f.status === "live"
          ? "📡 Canlı İzle"
          : f.status === "finished"
            ? "📋 Özet"
            : "⏳ Saati Bekle / İzle";
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

  async function ensureLeagueReady() {
    try {
      const next = await apiFetch("/api/fixtures/next");
      if (next && next.fixture) return next.fixture;
      await apiFetch("/api/league/fill-bots", {
        method: "POST",
        body: JSON.stringify({
          targetSize: 10,
          forceFixtures: true,
          intervalHours: 3,
        }),
      });
      await refreshNextMatchFromServer();
      return _emNextFixture;
    } catch (e) {
      console.warn("[em] ensureLeagueReady", e);
      return null;
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
    try {
      await ensureLeagueReady();
    } catch (e) {}
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

    socket.on("fixture:live", (payload) => {
      try {
        addLog("📡 Maç saati geldi — canlı yayında.", "tactics-log");
        const status = document.getElementById("matchStatus");
        if (status) status.innerText = "📡 CANLI";
        // Odaya tekrar bağlan / state iste
        const fid =
          (payload && payload.fixtureId) || window._emWatchingFixtureId;
        if (fid && socket) socket.emit("fixture:watch", { fixtureId: fid });
      } catch (e) {}
    });

    socket.on("fixture:status", (d) => {
      try {
        const status = document.getElementById("matchStatus");
        if (!status || !d) return;
        if (d.status === "live") {
          status.innerText = "📡 CANLI";
        } else if (d.status === "scheduled" && d.kickoffAt) {
          const kick = new Date(d.kickoffAt).getTime();
          const left = Math.max(0, kick - Date.now());
          const m = Math.floor(left / 60000);
          const s = Math.floor((left % 60000) / 1000);
          status.innerText =
            "⏳ Maç saati bekleniyor — " +
            m +
            ":" +
            String(s).padStart(2, "0");
        } else if (d.status === "finished") {
          status.innerText = "🏁 Maç bitmiş";
        } else {
          status.innerText = "📡 " + (d.status || "bekleniyor");
        }
      } catch (e) {}
    });

    socket.on("match:state", (state) => {
      applyServerPositions(state);
      renderServerMatchState(state);
      maybeShowInmatchPanel(state);
    });

    socket.on("match:tactics:result", (r) => {
      const note = document.getElementById("inmatchTacticsNote");
      if (!r || r.ok) {
        try {
          addLog("⚙️ Taktik değişikliği uygulandı.", "tactics-log");
        } catch (e) {}
        if (note) note.innerText = "Taktik güncellendi.";
      } else if (note) {
        note.innerText = "Hata: " + (r.error || "bilinmeyen");
      }
    });

    socket.on("match:sub:result", (r) => {
      const note = document.getElementById("inmatchTacticsNote");
      if (r && r.ok) {
        try {
          addLog(
            "🔁 Değişiklik: " + r.out + " çıktı, " + r.in + " girdi. Kalan hak: " + r.subsLeft,
            "development",
          );
        } catch (e) {}
        if (note) note.innerText = "Değişiklik yapıldı. Kalan hak: " + r.subsLeft;
        try {
          populateInmatchSelects();
        } catch (e) {}
      } else if (note) {
        note.innerText = "Değişiklik başarısız: " + ((r && r.error) || "bilinmeyen");
      }
    });

    // Top el değiştirdikçe (~her CIRCULATION_MS'de bir) gelir — canvas'taki
    // topu anında o koordinata taşır, aradaki hareketi ball.update()'in
    // mevcut lerp'i (this.x += (targetX-this.x)*speed) yumuşatır.
    socket.on("match:ball", (d) => {
      try {
        if (typeof ball === "undefined") return;
        ball.holder = null; // sunucudan geliyor artık, yerel oyuncuyu takip etme
        if (d.x != null) {
          ball.x = d.x;
          ball.y = d.y;
          ball.targetX = d.x;
          ball.targetY = d.y;
        }
      } catch (e) {}
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
        if (window._emWatchPoll) {
          clearInterval(window._emWatchPoll);
          window._emWatchPoll = null;
        }
      } catch (e) {}
      await syncAllFromServer();
    });
  }

  // ------------------------------------------------------------
  // Sunucudan gelen statik formasyon koordinatlarını (state.positions)
  // ve top konumunu (state.ball) canvas'ın okuduğu global teamConfig /
  // ball nesnelerine yazar. Oyuncu x/y'si sadece diziliş/değişiklikte
  // gerçekten değişir; her state broadcast'inde aynı değerler tekrar
  // gelebilir (ucuz, state küçük).
  // ------------------------------------------------------------
  function applyServerPositions(state) {
    if (!state) return;
    if (state.positions) {
      if (Array.isArray(state.positions.home)) {
        state.positions.home.forEach((sp, i) => {
          const p = teamConfig.home.players[i];
          if (p && sp) {
            p.x = sp.x;
            p.y = sp.y;
            if (sp.pos) p.pos = sp.pos;
          }
        });
      }
      if (Array.isArray(state.positions.away)) {
        // Rakip kadrosu sadece izleme amaçlı — client'ta yoksa oluştur
        teamConfig.away.players = state.positions.away.map((sp, i) => {
          const existing = teamConfig.away.players[i] || {};
          existing.name = sp.name;
          existing.pos = sp.pos;
          existing.x = sp.x;
          existing.y = sp.y;
          existing.number = existing.number || i + 1;
          return existing;
        });
        try {
          teamConfig.away.name =
            (state.players && state.players.away && state.players.away.teamName) ||
            teamConfig.away.name;
        } catch (e) {}
      }
    }
    if (state.ball && typeof ball !== "undefined") {
      ball.holder = null;
      ball.x = state.ball.x;
      ball.y = state.ball.y;
      ball.targetX = state.ball.x;
      ball.targetY = state.ball.y;
    }
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

  function maybeShowInmatchPanel(state) {
    if (!state || state.minute < 60 || _emInmatchPanelShown) return;
    _emInmatchPanelShown = true;
    if (!_emMySide) return; // sadece izleyen (taraf değil) — kontrol paneli yok
    const panel = document.getElementById("inmatch-tactics-panel");
    if (panel) panel.style.display = "block";
    try {
      populateInmatchSelects();
    } catch (e) {}
    try {
      addLog("60' Maç içi taktik/değişiklik paneli aktif (senin tarafın: " + _emMySide + ").", "tactics-log");
    } catch (e) {}
  }

  function watchFixture(fixtureId) {
    if (!socket) connectSocket();
    try {
      hideMainMenuAndShowBack();
      switchPage("page-match");
      resetMatchEngineState();
    } catch (e) {}
    matchStarted = true; // lokal simülasyon kilitli — sunucu yönetiyor
    _emInmatchPanelShown = false;
    _emMySide = determineMySide(fixtureId);
    if (_emMySide == null) {
      // Fikstür önbellekte yoksa (ör. doğrudan link/eski liste) bir kere çek
      apiFetch("/api/fixtures")
        .then((data) => {
          (data.fixtures || []).forEach(cacheFixture);
          _emMySide = determineMySide(fixtureId);
        })
        .catch(() => {});
    }
    const startBtn = document.getElementById("startMatchBtn");
    if (startBtn) startBtn.style.display = "none";
    const status = document.getElementById("matchStatus");
    if (status) status.innerText = "⏳ Maç saati bekleniyor...";
    if (socket) socket.emit("fixture:watch", { fixtureId });
    window._emWatchingFixtureId = fixtureId;

    // Saat gelene kadar periyodik yeniden abone (scheduler maçı başlatınca state gelir)
    if (window._emWatchPoll) clearInterval(window._emWatchPoll);
    window._emWatchPoll = setInterval(function () {
      if (!window._emWatchingFixtureId || !socket) return;
      socket.emit("fixture:watch", { fixtureId: window._emWatchingFixtureId });
      refreshNextMatchFromServer().catch(function () {});
    }, 10000);
  }
  // ------------------------------------------------------------
  // Maç içi taktik/değişiklik panelini yerel simülasyondan koparıp
  // sunucudaki match:tactics / match:sub event'lerine bağlar.
  // Sadece izlenen maçta bir tarafa (home/away) sahipsek aktif olur —
  // saf izleyici (taraf değil) için buton tıklaması hiçbir şey yapmaz.
  // ------------------------------------------------------------
  function rewireInMatchControls() {
    function rewire(id, handler) {
      const old = document.getElementById(id);
      if (!old) return;
      const clone = old.cloneNode(true);
      old.parentNode.replaceChild(clone, old);
      clone.addEventListener("click", handler);
    }

    rewire("inmatchApplyTacticsBtn", () => {
      const note = document.getElementById("inmatchTacticsNote");
      if (!socket || !window._emWatchingFixtureId || !_emMySide) {
        if (note) note.innerText = "Bu maçta bir tarafa sahip değilsin.";
        return;
      }
      const tactics = {
        passStyle: (document.getElementById("inmatchPassStyle") || {}).value,
        gameStyle: (document.getElementById("inmatchGameStyle") || {}).value,
        attackDir: (document.getElementById("inmatchAttackDir") || {}).value,
      };
      socket.emit("match:tactics", {
        fixtureId: window._emWatchingFixtureId,
        side: _emMySide,
        tactics,
      });
      if (note) note.innerText = "Gönderildi...";
    });

    rewire("inmatchSubBtn", () => {
      const note = document.getElementById("inmatchTacticsNote");
      if (!socket || !window._emWatchingFixtureId || !_emMySide) {
        if (note) note.innerText = "Bu maçta bir tarafa sahip değilsin.";
        return;
      }
      const outIdx = parseInt((document.getElementById("inmatchOutSelect") || {}).value, 10);
      const inIdx = parseInt((document.getElementById("inmatchInSelect") || {}).value, 10);
      if (isNaN(outIdx) || isNaN(inIdx)) return;
      socket.emit("match:sub", {
        fixtureId: window._emWatchingFixtureId,
        side: _emMySide,
        outIdx,
        inIdx,
      });
      if (note) note.innerText = "Gönderildi...";
    });
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
      fixtures.forEach(cacheFixture);
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


  // ------------------------------------------------------------
  // Transfer piyasası (sunucu)
  // Lokal transferMarket dizisini sunucu listings ile doldurur;
  // teklif / listele / iptal API'ye gider.
  // ------------------------------------------------------------
  function mapServerListingToLocal(L) {
    const p = Object.assign({}, L.player || {});
    p.id = p.id || L.id;
    p.listingId = L.id;
    p.clubName = L.clubName;
    p.listedByUser = !!L.isMine;
    p.auctionStart = L.auctionStart;
    p.currentBid = L.currentBid;
    p.highestBidder = L.iAmHighest
      ? "Sen"
      : L.highestBidderName || null;
    p.highestBidderClubId = L.highestBidderClubId;
    p.auctionEndsAt = L.auctionEndsAt;
    p.bidHistory = [];
    p.fromMarket = true;
    p.marketValue = L.currentBid || L.auctionStart;
    return p;
  }

  async function fetchTransferMarketFromServer() {
    if (!getToken()) return false;
    try {
      const posEl = document.getElementById("transferPosFilter");
      const pos = posEl ? posEl.value : "";
      const q = pos ? "?pos=" + encodeURIComponent(pos) : "";
      const data = await apiFetch("/api/transfer/market" + q);
      const rows = data.listings || [];
      if (typeof transferMarket === "undefined") return false;
      transferMarket.length = 0;
      rows.forEach((L) => transferMarket.push(mapServerListingToLocal(L)));
      return true;
    } catch (e) {
      console.warn("[em] transfer market", e);
      return false;
    }
  }

  async function emPlaceBid(listingId, amount) {
    return apiFetch("/api/transfer/bid", {
      method: "POST",
      body: JSON.stringify({ listingId, amount }),
    });
  }

  async function emListPlayer(player, openPrice, hours) {
    return apiFetch("/api/transfer/list", {
      method: "POST",
      body: JSON.stringify({
        playerId: player.id,
        player: player,
        openPrice,
        hours,
      }),
    });
  }

  async function emCancelListing(listingId) {
    return apiFetch("/api/transfer/cancel", {
      method: "POST",
      body: JSON.stringify({ listingId }),
    });
  }

  function wireTransferToServer() {
    // goToTransfer
    const _origGo = window.goToTransfer;
    window.goToTransfer = async function () {
      try {
        hideMainMenuAndShowBack();
        switchPage("page-transfer");
      } catch (e) {
        if (_origGo) return _origGo();
      }
      const note = document.getElementById("transferNote");
      if (note) note.innerText = "Piyasa yükleniyor...";
      const ok = await fetchTransferMarketFromServer();
      if (!ok && typeof ensureTransferMarket === "function") {
        ensureTransferMarket(); // offline fallback
      }
      try {
        if (typeof renderTransferPage === "function") renderTransferPage();
      } catch (e) {}
      try {
        const eco = await apiFetch("/api/economy");
        applyServerEconomyToClient(eco);
        if (typeof renderTransferPage === "function") renderTransferPage();
      } catch (e) {}
    };

    // placeAuctionBid(idx) — lokal index → listingId
    window.placeAuctionBid = async function (idx) {
      if (typeof transferMarket === "undefined" || !transferMarket[idx]) return;
      const p = transferMarket[idx];
      const listingId = p.listingId || p.id;
      const minNext = Math.max(
        (p.currentBid || p.auctionStart || 0) +
          Math.max(1000, Math.round((p.currentBid || 0) * 0.02)),
        p.auctionStart || 0,
      );
      let amount = minNext;
      try {
        const raw = prompt(
          "Teklifiniz (€) — min " + minNext.toLocaleString("tr-TR"),
          String(minNext),
        );
        if (raw == null) return;
        amount = parseInt(String(raw).replace(/\D/g, ""), 10) || 0;
      } catch (e) {}
      const note = document.getElementById("transferNote");
      try {
        if (note) note.innerText = "Teklif gönderiliyor...";
        const res = await emPlaceBid(listingId, amount);
        if (note)
          note.innerText =
            "Teklif kabul: " +
            (typeof formatMoney === "function"
              ? formatMoney(amount)
              : amount + " €");
        await fetchTransferMarketFromServer();
        if (typeof renderTransferPage === "function") renderTransferPage();
      } catch (e) {
        if (note) note.innerText = e.message || "Teklif reddedildi";
      }
    };
    window.buyTransferPlayer = window.placeAuctionBid;

    // listPlayerForSale
    window.listPlayerForSale = async function (playerId) {
      const team = teamConfig.home;
      const all = [...(team.players || []), ...(team.bench || [])];
      const p = all.find((x) => String(x.id) === String(playerId));
      if (!p) return;
      const row = document.querySelector(
        '[data-sell-id="' + String(playerId).replace(/"/g, "") + '"]',
      );
      let openPrice = 0,
        hours = 24;
      if (row) {
        const pe = row.querySelector(".sell-price-input");
        const he = row.querySelector(".sell-hours-input");
        if (pe)
          openPrice = parseInt(String(pe.value).replace(/\D/g, ""), 10) || 0;
        if (he) hours = parseInt(he.value, 10) || 0;
      }
      const note = document.getElementById("transferNote");
      if (!openPrice || openPrice < 1000) {
        if (note) note.innerText = "Geçerli bir açılış fiyatı gir (min 1.000 €).";
        return;
      }
      if (!hours || hours < 24) {
        if (note) note.innerText = "Listede kalma süresi en az 24 saat olmalı.";
        return;
      }
      try {
        if (note) note.innerText = "Listeleniyor...";
        await emListPlayer(p, openPrice, hours);
        // Yerel kadrodan da çıkar (sunucu zaten çıkardı; UI senkron)
        let bi = (team.bench || []).findIndex(
          (x) => String(x.id) === String(playerId),
        );
        if (bi >= 0) team.bench.splice(bi, 1);
        else {
          const pi = (team.players || []).findIndex(
            (x) => String(x.id) === String(playerId),
          );
          if (pi >= 0) team.players.splice(pi, 1);
        }
        await fetchTransferMarketFromServer();
        try {
          const t = await apiFetch("/api/team");
          if (t && t.team) applyServerTeamToClient(t.team);
        } catch (e) {}
        if (typeof renderTransferPage === "function") renderTransferPage();
        if (note)
          note.innerText =
            p.name +
            " listede · " +
            (typeof formatMoney === "function"
              ? formatMoney(openPrice)
              : openPrice) +
            " · " +
            hours +
            "s";
      } catch (e) {
        if (note) note.innerText = e.message || "Listeleme başarısız";
      }
    };

    // cancelUserListing
    window.cancelUserListing = async function (playerId) {
      const note = document.getElementById("transferNote");
      const p = (transferMarket || []).find(
        (x) => x.listedByUser && String(x.id) === String(playerId),
      );
      const listingId = p ? p.listingId || p.id : playerId;
      try {
        if (note) note.innerText = "Çekiliyor...";
        await emCancelListing(listingId);
        await fetchTransferMarketFromServer();
        try {
          const t = await apiFetch("/api/team");
          if (t && t.team) applyServerTeamToClient(t.team);
        } catch (e) {}
        if (typeof renderTransferPage === "function") renderTransferPage();
        if (note) note.innerText = "İlan çekildi, oyuncu yedeğe döndü.";
      } catch (e) {
        if (note) note.innerText = e.message || "İptal başarısız";
      }
    };

    // refreshTransferMarket
    window.refreshTransferMarket = async function () {
      const note = document.getElementById("transferNote");
      try {
        await apiFetch("/api/transfer/refresh", {
          method: "POST",
          body: JSON.stringify({}),
        });
        await fetchTransferMarketFromServer();
        if (typeof renderTransferPage === "function") renderTransferPage();
        if (note) note.innerText = "Piyasa yenilendi.";
      } catch (e) {
        if (note) note.innerText = e.message || "Yenileme başarısız";
      }
    };

    // Filtre değişince sunucudan çek
    const posEl = document.getElementById("transferPosFilter");
    if (posEl && !posEl._emWired) {
      posEl.addEventListener("change", async function () {
        await fetchTransferMarketFromServer();
        if (typeof renderTransferPage === "function") renderTransferPage();
      });
      posEl._emWired = true;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(wireTransferToServer, 80),
    );
  } else {
    setTimeout(wireTransferToServer, 80);
  }


  // ------------------------------------------------------------
  // Altyapı / Akademi (sunucu)
  // ------------------------------------------------------------
  function applyYouthStateToClient(state) {
    if (!state || typeof youthAcademy === "undefined") return;
    youthAcademy.scoutLevel = state.scoutLevel;
    youthAcademy.academyLevel = state.academyLevel;
    youthAcademy.maxScout = state.maxScout;
    youthAcademy.maxAcademy = state.maxAcademy;
    youthAcademy.drawsThisSeason = state.drawsThisSeason;
    youthAcademy.maxDrawsPerSeason = state.maxDrawsPerSeason;
    youthAcademy.lastDrawWeekKey = state.lastDrawWeekKey || "";
    youthAcademy.scoutUpgradeUntil = state.scoutUpgradeUntil || 0;
    youthAcademy.academyUpgradeUntil = state.academyUpgradeUntil || 0;
    youthAcademy.pendingScoutLevel = state.pendingScoutLevel;
    youthAcademy.pendingAcademyLevel = state.pendingAcademyLevel;
    try {
      if (typeof updateYouthAcademyUI === "function") updateYouthAcademyUI();
      if (typeof updateYouthUI === "function") updateYouthUI("home");
    } catch (e) {}
    // Recent roster listesi
    try {
      const roster = document.getElementById("homeYouthRoster");
      if (roster && Array.isArray(state.recent)) {
        if (!state.recent.length) {
          roster.innerHTML =
            '<div style="color:#64748b;font-size:12px;text-align:center;padding:8px;">Henüz keşif yok.</div>';
        } else {
          roster.innerHTML = state.recent
            .map(function (r) {
              return (
                '<div class="youth-row"><span class="player-name">' +
                (r.name || "?") +
                '</span><span class="player-pos">' +
                (r.pos || "") +
                " · " +
                (r.age || "?") +
                "y</span></div>"
              );
            })
            .join("");
        }
      }
    } catch (e) {}
  }

  async function fetchYouthFromServer() {
    if (!getToken()) return null;
    try {
      const data = await apiFetch("/api/youth");
      if (data && data.state) {
        applyYouthStateToClient(data.state);
        return data.state;
      }
    } catch (e) {
      console.warn("[em] youth", e);
    }
    return null;
  }

  function wireYouthToServer() {
    const _origGo = window.goToYouth;
    window.goToYouth = async function () {
      try {
        hideMainMenuAndShowBack();
        switchPage("page-youth");
      } catch (e) {
        if (_origGo) return _origGo();
      }
      const note = document.getElementById("youthScoutNote");
      if (note) note.innerText = "Altyapı yükleniyor...";
      const st = await fetchYouthFromServer();
      if (!st) {
        // offline fallback
        try {
          if (typeof updateYouthUI === "function") updateYouthUI("home");
          if (typeof renderYouthRoster === "function") renderYouthRoster("home");
          if (typeof updateYouthAcademyUI === "function") updateYouthAcademyUI();
        } catch (e) {}
      }
      if (note && st) {
        note.innerText = st.canDrawThisWeek
          ? "Bu hafta keşif hakkın var (" +
            st.drawsThisSeason +
            "/" +
            st.maxDrawsPerSeason +
            ")"
          : "Bu hafta hak kullanıldı. Haftaya tekrar dene.";
      }
      try {
        const eco = await apiFetch("/api/economy");
        applyServerEconomyToClient(eco);
      } catch (e) {}
    };

    window.drawYouthPlayer = async function (side) {
      if (typeof matchStarted !== "undefined" && matchStarted) {
        try {
          if (typeof setYouthNote === "function")
            setYouthNote("Maç sırasında keşif yapılamaz.");
        } catch (e) {}
        return;
      }
      const skillSel = document.getElementById("youthPreferredSkill");
      const preferredSkill = skillSel ? skillSel.value : "";
      const note = document.getElementById("youthScoutNote");
      try {
        if (note) note.innerText = "Keşfediliyor...";
        const res = await apiFetch("/api/youth/draw", {
          method: "POST",
          body: JSON.stringify({ preferredSkill: preferredSkill || null }),
        });
        if (res.state) applyYouthStateToClient(res.state);
        if (res.player) {
          // Yerel yedeğe de ekle (sunucu zaten ekledi; UI anlık)
          try {
            const team = teamConfig.home;
            team.bench = team.bench || [];
            const exists = team.bench.some(
              (p) => p && String(p.id) === String(res.player.id),
            );
            if (!exists) team.bench.push(res.player);
          } catch (e) {}
          try {
            if (typeof addLog === "function")
              addLog(
                "🌱 Akademi: " +
                  res.player.name +
                  " (" +
                  res.player.pos +
                  ", " +
                  res.player.age +
                  " yaş) kadroya katıldı",
                "development",
              );
          } catch (e) {}
          if (note)
            note.innerText =
              res.player.name +
              " keşfedildi!" +
              (preferredSkill ? " · " + preferredSkill : "");
        }
        try {
          const t = await apiFetch("/api/team");
          if (t && t.team) applyServerTeamToClient(t.team);
        } catch (e) {}
        try {
          if (typeof renderYouthRoster === "function") renderYouthRoster("home");
          if (typeof populateSubSelects === "function") populateSubSelects("home");
        } catch (e) {}
      } catch (e) {
        if (note) note.innerText = e.message || "Keşif başarısız";
      }
    };

    window.upgradeYouthScout = async function () {
      const note = document.getElementById("youthScoutNote");
      try {
        if (note) note.innerText = "Scout yükseltmesi başlatılıyor...";
        const res = await apiFetch("/api/youth/upgrade", {
          method: "POST",
          body: JSON.stringify({ kind: "scout" }),
        });
        if (res.state) applyYouthStateToClient(res.state);
        try {
          const eco = await apiFetch("/api/economy");
          applyServerEconomyToClient(eco);
        } catch (e) {}
        if (note)
          note.innerText =
            "Scout yükseltmesi başladı" +
            (res.cost && typeof formatMoney === "function"
              ? " · " + formatMoney(res.cost)
              : "");
      } catch (e) {
        if (note) note.innerText = e.message || "Yükseltme başarısız";
      }
    };

    window.upgradeYouthAcademy = async function () {
      const note = document.getElementById("youthScoutNote");
      try {
        if (note) note.innerText = "Akademi yükseltmesi başlatılıyor...";
        const res = await apiFetch("/api/youth/upgrade", {
          method: "POST",
          body: JSON.stringify({ kind: "academy" }),
        });
        if (res.state) applyYouthStateToClient(res.state);
        try {
          const eco = await apiFetch("/api/economy");
          applyServerEconomyToClient(eco);
        } catch (e) {}
        if (note)
          note.innerText =
            "Akademi yükseltmesi başladı" +
            (res.cost && typeof formatMoney === "function"
              ? " · " + formatMoney(res.cost)
              : "");
      } catch (e) {
        if (note) note.innerText = e.message || "Yükseltme başarısız";
      }
    };

    // Periyodik state yenile (yükseltme geri sayımı)
    if (!window._emYouthPoll) {
      window._emYouthPoll = setInterval(async function () {
        try {
          const page = document.getElementById("page-youth");
          if (!page || !page.classList.contains("active")) return;
          if (!getToken()) return;
          await fetchYouthFromServer();
        } catch (e) {}
      }, 3000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(wireYouthToServer, 90),
    );
  } else {
    setTimeout(wireYouthToServer, 90);
  }


  // ------------------------------------------------------------
  // Antrenman (sunucu)
  // ------------------------------------------------------------
  function applyTrainingStateToClient(state) {
    if (!state) return;
    try {
      if (Array.isArray(state.coaches) && typeof clubCoaches !== "undefined") {
        clubCoaches = state.coaches.slice();
        if (typeof clubCoach !== "undefined") {
          clubCoach = clubCoaches[0] || null;
        }
      }
    } catch (e) {}
    try {
      if (typeof renderClubCoachesList === "function") renderClubCoachesList();
      if (typeof populateCoachHireSelect === "function") populateCoachHireSelect();
      if (typeof updateBudgetUI === "function") updateBudgetUI();
    } catch (e) {}
    // Recent results
    try {
      const list = document.getElementById("trainingResultList");
      if (list && Array.isArray(state.recent)) {
        if (!state.recent.length) {
          list.innerHTML =
            '<div style="color:#64748b;font-size:12px;text-align:center;padding:8px;">Henüz antrenman yok.</div>';
        } else {
          list.innerHTML = state.recent
            .map(function (r) {
              return (
                '<div class="youth-row"><span class="player-name">' +
                (r.name || "?") +
                '</span><span style="color:#86efac;font-size:11px;">' +
                (r.skillLabel || r.skill || "") +
                ": +" +
                (r.delta != null ? r.delta : "?") +
                " → " +
                (r.to != null ? Math.round(r.to) : "") +
                "</span></div>"
              );
            })
            .join("");
        }
      }
    } catch (e) {}
    try {
      if (state.conditionSummary) {
        const el = document.getElementById("trainingConditionSummary");
        const cs = state.conditionSummary;
        if (el) {
          const avg = cs.avg || 0;
          el.innerHTML =
            'Ortalama kondisyon: <b style="color:' +
            (avg >= 80 ? "#4ade80" : avg >= 70 ? "#facc15" : "#f87171") +
            ';">' +
            avg +
            "%</b> · Düşük (&lt;70): <b>" +
            (cs.low || 0) +
            "</b> oyuncu · Kondisyon antrenman verimini etkiler";
        }
      }
    } catch (e) {}
  }

  async function fetchTrainingFromServer() {
    if (!getToken()) return null;
    try {
      const data = await apiFetch("/api/training");
      if (data && data.state) {
        applyTrainingStateToClient(data.state);
        return data.state;
      }
    } catch (e) {
      console.warn("[em] training", e);
    }
    return null;
  }

  function wireTrainingToServer() {
    const _origGo = window.goToTraining;
    window.goToTraining = async function () {
      try {
        hideMainMenuAndShowBack();
        switchPage("page-training");
      } catch (e) {
        if (_origGo) return _origGo();
      }
      await fetchTrainingFromServer();
      try {
        const t = await apiFetch("/api/team");
        if (t && t.team) applyServerTeamToClient(t.team);
      } catch (e) {}
      try {
        const eco = await apiFetch("/api/economy");
        applyServerEconomyToClient(eco);
      } catch (e) {}
      try {
        if (typeof renderTrainingSquadList === "function")
          renderTrainingSquadList();
        if (typeof populateCoachHireSelect === "function")
          populateCoachHireSelect();
      } catch (e) {}
    };

    // Bireysel antrenman — lokal fonksiyonu override
    window.runSkillTrainingForPlayer = async function (player, skill) {
      if (!player || !skill) return;
      const note = document.getElementById("trainingResultNote");
      try {
        if (note) note.innerText = "Antrenman uygulanıyor...";
        const res = await apiFetch("/api/training/player", {
          method: "POST",
          body: JSON.stringify({ playerId: player.id, skill: skill }),
        });
        if (res.result) {
          const r = res.result;
          // Yerel oyuncu objesini güncelle
          try {
            const team = teamConfig.home;
            const all = [...(team.players || []), ...(team.bench || [])];
            const local = all.find(
              (p) => p && String(p.id) === String(player.id),
            );
            if (local) {
              local[skill] = r.to;
              local.condition = r.condition;
            }
          } catch (e) {}
          if (note)
            note.innerText =
              r.name +
              ": " +
              (r.skillLabel || skill) +
              " +" +
              r.delta +
              " → " +
              r.to;
          try {
            if (typeof addLog === "function")
              addLog(
                "🎯 Bireysel antrenman: " +
                  r.name +
                  " · " +
                  (r.skillLabel || skill) +
                  " +" +
                  r.delta,
                "development",
              );
          } catch (e) {}
        }
        if (res.recent) {
          applyTrainingStateToClient({
            coaches:
              typeof clubCoaches !== "undefined" ? clubCoaches : [],
            recent: res.recent,
          });
        }
        try {
          if (typeof renderTrainingSquadList === "function")
            renderTrainingSquadList();
        } catch (e) {}
      } catch (e) {
        if (note) note.innerText = e.message || "Antrenman başarısız";
      }
    };

    window.trainWholeSquadSameSkill = async function () {
      const bulk = document.getElementById("bulkTrainSkillSelect");
      const skill =
        (bulk && bulk.value) ||
        (typeof clubCoach !== "undefined" && clubCoach && clubCoach.skill) ||
        "stamina";
      const note = document.getElementById("trainingResultNote");
      try {
        if (note) note.innerText = "Tüm kadro antrenmanı...";
        const res = await apiFetch("/api/training/squad", {
          method: "POST",
          body: JSON.stringify({ skill: skill }),
        });
        // Takımı sunucudan çek
        try {
          const t = await apiFetch("/api/team");
          if (t && t.team) applyServerTeamToClient(t.team);
        } catch (e) {}
        if (res.recent) {
          applyTrainingStateToClient({
            coaches:
              typeof clubCoaches !== "undefined" ? clubCoaches : [],
            recent: res.recent,
          });
        }
        if (note)
          note.innerText =
            "Tüm kadro (" +
            (res.count || 0) +
            " oyuncu) · " +
            (res.skillLabel || skill) +
            " antrenmanı uygulandı.";
        try {
          if (typeof renderTrainingSquadList === "function")
            renderTrainingSquadList();
        } catch (e) {}
      } catch (e) {
        if (note) note.innerText = e.message || "Toplu antrenman başarısız";
      }
    };
    window.trainWholeTeamWithCoach = window.trainWholeSquadSameSkill;

    // Antrenör işe al / güncelle
    const _origApplyCoach = window.applyCoachSettings;
    window.applyCoachSettings = async function () {
      const skillSel = document.getElementById("coachSkillSelect");
      const levelSel = document.getElementById("coachLevelSelect");
      const skill = skillSel ? skillSel.value : "stamina";
      const level = levelSel ? parseInt(levelSel.value, 10) || 1 : 1;
      const note = document.getElementById("trainingResultNote");
      try {
        const res = await apiFetch("/api/training/coach", {
          method: "POST",
          body: JSON.stringify({ skill: skill, level: level }),
        });
        if (res.coaches) {
          applyTrainingStateToClient({
            coaches: res.coaches,
            recent: [],
          });
        }
        if (note)
          note.innerText =
            "Antrenör kaydedildi: " + skill + " Sv." + level;
        try {
          if (typeof renderTrainingSquadList === "function")
            renderTrainingSquadList();
        } catch (e) {}
      } catch (e) {
        if (note) note.innerText = e.message || "Antrenör kaydı başarısız";
        if (_origApplyCoach) {
          try {
            _origApplyCoach();
          } catch (e2) {}
        }
      }
    };
    window.hireSelectedCoach = window.applyCoachSettings;

    window.removeClubCoach = async function (skill) {
      const note = document.getElementById("trainingResultNote");
      try {
        const res = await apiFetch("/api/training/coach/remove", {
          method: "POST",
          body: JSON.stringify({ skill: skill }),
        });
        if (res.coaches) {
          applyTrainingStateToClient({
            coaches: res.coaches,
            recent: [],
          });
        }
        if (note) note.innerText = "Antrenör çıkarıldı: " + skill;
      } catch (e) {
        if (note) note.innerText = e.message || "Çıkarma başarısız";
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(wireTrainingToServer, 100),
    );
  } else {
    setTimeout(wireTrainingToServer, 100);
  }


  // ------------------------------------------------------------
  // Stadyum (sunucu)
  // ------------------------------------------------------------
  function applyStadiumToClient(st) {
    if (!st || typeof stadium === "undefined") return;
    stadium.name = st.name || stadium.name;
    stadium.capacity = st.capacity != null ? st.capacity : stadium.capacity;
    stadium.ticketPrice =
      st.ticketPrice != null ? st.ticketPrice : stadium.ticketPrice;
    stadium.seatUpgradeCost =
      st.seatUpgradeCost != null
        ? st.seatUpgradeCost
        : stadium.seatUpgradeCost;
    try {
      const nameEl = document.getElementById("stadiumName");
      if (nameEl) nameEl.innerText = stadium.name;
    } catch (e) {}
    try {
      if (typeof updateStadiumUI === "function") updateStadiumUI();
    } catch (e) {}
  }

  async function fetchStadiumFromServer() {
    if (!getToken()) return null;
    try {
      const data = await apiFetch("/api/stadium");
      if (data && data.stadium) {
        applyStadiumToClient(data.stadium);
        return data.stadium;
      }
    } catch (e) {
      console.warn("[em] stadium", e);
    }
    return null;
  }

  function wireStadiumToServer() {
    const _origGo = window.goToStadium;
    window.goToStadium = async function () {
      try {
        hideMainMenuAndShowBack();
        switchPage("page-stadium");
      } catch (e) {
        if (_origGo) return _origGo();
      }
      const note = document.getElementById("stadiumNote");
      if (note) note.innerText = "Yükleniyor...";
      const st = await fetchStadiumFromServer();
      try {
        const eco = await apiFetch("/api/economy");
        applyServerEconomyToClient(eco);
      } catch (e) {}
      if (note) {
        note.innerText = st
          ? "Kapasite " +
            (st.capacity || 0).toLocaleString("tr-TR") +
            " · Bilet " +
            (st.ticketPrice || 0) +
            " €"
          : "";
      }
    };

    window.upgradeStadiumSeats = async function () {
      const note = document.getElementById("stadiumNote");
      try {
        if (note) note.innerText = "Yükseltiliyor...";
        const res = await apiFetch("/api/stadium/upgrade", {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (res.state) applyStadiumToClient(res.state);
        try {
          const eco = await apiFetch("/api/economy");
          applyServerEconomyToClient(eco);
        } catch (e) {}
        if (note)
          note.innerText =
            "Kapasite " +
            (res.state && res.state.capacity
              ? res.state.capacity.toLocaleString("tr-TR")
              : "?") +
            " oldu" +
            (res.cost && typeof formatMoney === "function"
              ? " · " + formatMoney(res.cost)
              : "");
      } catch (e) {
        if (note) note.innerText = e.message || "Yükseltme başarısız";
      }
    };

    // Opsiyonel: bilet fiyatı (UI yoksa window'dan çağrılabilir)
    window.setStadiumTicketPrice = async function (price) {
      const note = document.getElementById("stadiumNote");
      try {
        const res = await apiFetch("/api/stadium/ticket", {
          method: "POST",
          body: JSON.stringify({ price: price }),
        });
        if (res.state) applyStadiumToClient(res.state);
        if (note)
          note.innerText = "Bilet fiyatı " + (res.state && res.state.ticketPrice) + " €";
      } catch (e) {
        if (note) note.innerText = e.message || "Güncelleme başarısız";
      }
    };

    window.renameStadium = async function (name) {
      const note = document.getElementById("stadiumNote");
      try {
        const res = await apiFetch("/api/stadium/rename", {
          method: "POST",
          body: JSON.stringify({ name: name }),
        });
        if (res.state) applyStadiumToClient(res.state);
        if (note) note.innerText = "Stadyum adı: " + (res.state && res.state.name);
      } catch (e) {
        if (note) note.innerText = e.message || "İsim güncellenemedi";
      }
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(wireStadiumToServer, 110),
    );
  } else {
    setTimeout(wireStadiumToServer, 110);
  }


  // ------------------------------------------------------------
  // Forum + Mesajlar + Bildirimler (sunucu)
  // ------------------------------------------------------------
  let _emRecipients = [];

  function renderForumFromServer(posts) {
    const list = document.getElementById("forumPostsList");
    if (!list) return;
    if (!posts || !posts.length) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:8px;">Henüz gönderi yok.</div>';
      return;
    }
    list.innerHTML = posts
      .map(function (p) {
        return (
          '<div style="padding:12px;margin-bottom:8px;background:#0f172a;border:1px solid #2c3a52;border-radius:12px;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><b style="color:#38bdf8;">' +
          (p.user || "?") +
          '</b><span style="color:#64748b;font-size:11px;">' +
          (p.time || "") +
          "</span></div>" +
          '<div style="color:#e2e8f0;font-size:13px;">' +
          (p.text || "") +
          "</div></div>"
        );
      })
      .join("");
  }

  async function fetchForumFromServer() {
    try {
      const data = await apiFetch("/api/forum");
      renderForumFromServer(data.posts || []);
      return data.posts || [];
    } catch (e) {
      console.warn("[em] forum", e);
      return null;
    }
  }

  function wireSocialToServer() {
    // Forum
    const _origGoForum = window.goToForum;
    window.goToForum = async function () {
      try {
        hideMainMenuAndShowBack();
        switchPage("page-forum");
      } catch (e) {
        if (_origGoForum) return _origGoForum();
      }
      await fetchForumFromServer();
    };

    window.addForumPost = async function () {
      const inp = document.getElementById("forumPostInput");
      const text = ((inp && inp.value) || "").trim();
      if (!text) return;
      try {
        const res = await apiFetch("/api/forum", {
          method: "POST",
          body: JSON.stringify({ text: text }),
        });
        if (inp) inp.value = "";
        renderForumFromServer(res.posts || (res.post ? [res.post] : []));
        if (!res.posts && res.post) await fetchForumFromServer();
      } catch (e) {
        alert(e.message || "Paylaşım başarısız");
      }
    };

    window.renderForum = async function () {
      await fetchForumFromServer();
    };

    // Mesajlar
    window.openMessages = async function (e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      try {
        const data = await apiFetch("/api/messages");
        _emRecipients = data.recipients || [];
        const sel = document.getElementById("msgToUser");
        if (sel) {
          if (!_emRecipients.length) {
            sel.innerHTML =
              '<option value="">— Online menajer yok —</option>';
          } else {
            sel.innerHTML = _emRecipients
              .map(function (u) {
                return (
                  '<option value="' +
                  u.userId +
                  '" data-username="' +
                  (u.username || "").replace(/"/g, "") +
                  '">' +
                  (u.username || u.userId) +
                  "</option>"
                );
              })
              .join("");
          }
        }
        // userMessages globalini doldur (renderUserMessages için)
        if (typeof userMessages !== "undefined") {
          userMessages.length = 0;
          (data.messages || []).forEach(function (m) {
            userMessages.push({
              from: m.from,
              to: m.to,
              text: m.text,
              time: m.time,
            });
          });
        }
        if (typeof renderUserMessages === "function") renderUserMessages();
      } catch (err) {
        console.warn("[em] messages", err);
      }
      const modal = document.getElementById("messagesModal");
      if (modal) {
        modal.style.zIndex = "100050";
        modal.classList.add("active");
      }
    };

    window.sendUserMessage = async function () {
      const sel = document.getElementById("msgToUser");
      const inp = document.getElementById("msgTextInput");
      const toUserId = sel ? sel.value : "";
      const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
      const toUsername = opt
        ? opt.getAttribute("data-username") || opt.textContent
        : "";
      const text = ((inp && inp.value) || "").trim();
      if (!toUserId || !text) return;
      try {
        const res = await apiFetch("/api/messages", {
          method: "POST",
          body: JSON.stringify({
            toUserId: toUserId,
            toUsername: toUsername,
            text: text,
          }),
        });
        if (inp) inp.value = "";
        if (typeof userMessages !== "undefined" && res.messages) {
          userMessages.length = 0;
          res.messages.forEach(function (m) {
            userMessages.push({
              from: m.from,
              to: m.to,
              text: m.text,
              time: m.time,
            });
          });
        }
        if (typeof renderUserMessages === "function") renderUserMessages();
      } catch (err) {
        alert(err.message || "Mesaj gönderilemedi");
      }
    };

    // Bildirimler
    window.pushNotification = function (icon, text, time) {
      // Lokal gösterim + sunucuya yazmak için endpoint yok (sunucu pushNotification kendi çağırır)
      // Client-side anlık: gameNotifications
      try {
        if (typeof gameNotifications !== "undefined") {
          gameNotifications.unshift({
            icon: icon || "🔔",
            text: text,
            time: time || "Şimdi",
          });
          if (gameNotifications.length > 40) gameNotifications.pop();
        }
      } catch (e) {}
      const dot = document.getElementById("notifDot");
      if (dot) dot.classList.add("active");
    };

    window.openNotifications = async function (e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      let notifs = [];
      try {
        const data = await apiFetch("/api/notifications");
        notifs = data.notifications || [];
        // okundu işaretle
        try {
          await apiFetch("/api/notifications/read", {
            method: "POST",
            body: JSON.stringify({}),
          });
        } catch (e2) {}
      } catch (err) {
        console.warn("[em] notifs", err);
      }
      // Lokal gameNotifications ile birleştir
      try {
        if (typeof gameNotifications !== "undefined") {
          gameNotifications.forEach(function (n) {
            notifs.push({
              icon: n.icon,
              text: n.text,
              time: n.time,
            });
          });
        }
      } catch (e) {}
      const list = document.getElementById("notificationsList");
      if (list) {
        if (!notifs.length) {
          list.innerHTML =
            '<div style="color:#64748b;text-align:center;padding:8px;">Bildirim yok.</div>';
        } else {
          list.innerHTML = notifs
            .map(function (n) {
              return (
                '<div class="team-player-row"><span style="font-size:16px;margin-right:8px;">' +
                (n.icon || "🔔") +
                '</span><span style="flex:1;color:#cbd5e1;font-size:12.5px;">' +
                (n.text || "") +
                '</span><span style="color:#64748b;font-size:10px;">' +
                (n.time || "") +
                "</span></div>"
              );
            })
            .join("");
        }
      }
      const dot = document.getElementById("notifDot");
      if (dot) dot.classList.remove("active");
      const modal = document.getElementById("notificationsModal");
      if (modal) {
        modal.style.zIndex = "100050";
        modal.classList.add("active");
      }
    };

    // Okunmamış bildirim rozeti poll
    if (!window._emNotifPoll) {
      window._emNotifPoll = setInterval(async function () {
        if (!getToken()) return;
        try {
          const data = await apiFetch("/api/notifications");
          const dot = document.getElementById("notifDot");
          if (dot) {
            if ((data.unread || 0) > 0) dot.classList.add("active");
            else dot.classList.remove("active");
          }
        } catch (e) {}
      }, 15000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () =>
      setTimeout(wireSocialToServer, 120),
    );
  } else {
    setTimeout(wireSocialToServer, 120);
  }

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
  rewireInMatchControls();
  tryAutoLogin();
})();
