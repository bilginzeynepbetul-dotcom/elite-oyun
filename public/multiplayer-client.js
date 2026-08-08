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
        // Elle kaydedilmiş x/y varsa koru; yoksa formasyona göre mevkiden yerleştir
        const hasXY =
          p.x != null &&
          p.y != null &&
          Number(p.x) > 0 &&
          Number(p.y) > 0;
        if (!hasXY) {
          const formKey =
            (typeof teamConfig !== "undefined" &&
              teamConfig.home &&
              teamConfig.home.currentFormation) ||
            "4-4-2";
          let slots = null;
          try {
            if (typeof FORMATION_PRESETS !== "undefined" && FORMATION_PRESETS[formKey])
              slots = FORMATION_PRESETS[formKey];
          } catch (e) {}
          if (!slots && typeof getHomePositions === "function")
            slots = getHomePositions();
          slots = slots || [];
          const want = String(p.pos || p.naturalPos || "").toUpperCase();
          let slot =
            slots.find(function (sl, si) {
              return String(sl.pos || "").toUpperCase() === want && !sl._used;
            }) || null;
          if (slot) slot._used = true;
          if (!slot) slot = slots[idx] || slots[slots.length - 1];
          if (slot) {
            p.x = slot.x;
            p.y = slot.y;
            if (slot.pos) p.pos = slot.pos;
          } else {
            p.x = 300;
            p.y = 200;
          }
        }
      } catch (e) {
        p.x = p.x || 300;
        p.y = p.y || 200;
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
    if (serverTeam.formation || serverTeam.currentFormation) {
      teamConfig.home.currentFormation =
        serverTeam.currentFormation ||
        serverTeam.formation ||
        teamConfig.home.currentFormation ||
        "4-4-2";
    } else {
      teamConfig.home.currentFormation =
        teamConfig.home.currentFormation || "4-4-2";
    }
    try {
      // Sadece pos etiketlerini düzelt; x/y elle kaydedildiyse bozma
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
        if (window._emWatchingFixtureId) {
          try {
            window.lastPlayedFixtureId = window._emWatchingFixtureId;
            if (typeof lastPlayedFixtureId !== "undefined") {
              lastPlayedFixtureId = window._emWatchingFixtureId;
            }
          } catch (e2) {}
        }
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
    updateInmatchHud(state);
  }

  // "Sıra kimde / kalan değişiklik hakkı" HUD'u — panel görünürse her
  // state güncellemesinde tazelenir (sonuç mesajları da aynı alanı
  // kullandığı için bir sonraki state gelince otomatik geri döner).
  function updateInmatchHud(state) {
    const panel = document.getElementById("inmatch-tactics-panel");
    const note = document.getElementById("inmatchTacticsNote");
    if (!panel || !note || panel.style.display === "none") return;
    if (!state.subsUsed || !_emMySide) return;
    const oppSide = _emMySide === "home" ? "away" : "home";
    const mySubsLeft = state.subsMax - (state.subsUsed[_emMySide] || 0);
    const oppSubsLeft = state.subsMax - (state.subsUsed[oppSide] || 0);
    const possessionLabel =
      state.possessionSide === _emMySide
        ? "⚽ Top sende"
        : state.possessionSide
          ? "⚽ Top rakipte"
          : "";
    note.innerText =
      possessionLabel +
      " · Senin kalan değişiklik: " +
      mySubsLeft +
      " · Rakip kalan: " +
      oppSubsLeft;
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

  // ------------------------------------------------------------
  // Kupa (gerçek eleme usulü, backend'den) — eski sahte
  // buildCupFixtureHTML/buildPlayedMatchesHTML('cup') yerine geçer.
  // showCompSub zaten global bir fonksiyon (window.showCompSub ile
  // aynı binding), bu yüzden index.html'deki "Kupa" sekme butonları
  // hiç değişmeden buraya düşer.
  // ------------------------------------------------------------
  let _cupBracketCache = null;

  async function fetchCupBracket() {
    const data = await apiFetch("/api/cup/bracket");
    _cupBracketCache = data;
    return data;
  }

  function cupTeamLink(name) {
    const n = name || "—";
    const safe = String(n).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return (
      '<span class="clickable-team" style="cursor:pointer;color:#e2e8f0;text-decoration:underline;" onclick="event.stopPropagation();typeof openClubProfileByName===\'function\'&&openClubProfileByName(\'' +
      safe +
      "')\">" +
      n +
      "</span>"
    );
  }

  function cupMatchRow(f) {
    if (f.id) {
      cacheFixture({
        id: f.id,
        homeClubId: f.homeClubId,
        awayClubId: f.awayClubId,
      });
    }
    let scoreHtml;
    let metaHtml = "";
    let btn = "";
    if (f.status === "bye") {
      scoreHtml = '<span style="color:#64748b;">BYE</span>';
    } else if (f.status === "finished") {
      const sc = f.homeGoals + " - " + f.awayGoals;
      scoreHtml =
        '<b style="color:#facc15;cursor:pointer;text-decoration:underline;" title="Maç raporu" onclick="event.stopPropagation();openMatchReportByScore(' +
        JSON.stringify(f.homeName || "") +
        "," +
        JSON.stringify(f.awayName || "") +
        "," +
        JSON.stringify(sc) +
        ')">' +
        sc +
        "</b>" +
        (f.penalties
          ? ' <span style="color:#94a3b8;font-size:10px;">(pen)</span>'
          : "");
    } else if (f.status === "live") {
      scoreHtml =
        '<span style="color:#f87171;font-weight:700;cursor:pointer;" onclick="event.stopPropagation();watchFixture(\'' +
        (f.id || "") +
        "')\">● CANLI</span>";
      btn =
        '<button class="sub-btn" style="width:auto;padding:3px 8px;font-size:10px;margin-left:6px;" onclick="watchFixture(\'' +
        f.id +
        '\')">İzle</button>';
    } else {
      scoreHtml = '<span style="color:#64748b;">vs</span>';
      btn =
        f.id
          ? '<button class="sub-btn" style="width:auto;padding:3px 8px;font-size:10px;margin-left:6px;" onclick="watchFixture(\'' +
            f.id +
            '\')">İzle</button>'
          : "";
    }
    if (f.kickoffAt) {
      const when = new Date(f.kickoffAt).toLocaleString("tr-TR", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      metaHtml =
        '<div style="font-size:10px;color:#64748b;margin-top:3px;">' +
        when +
        (f.roundLabel ? " · " + f.roundLabel : "") +
        "</div>";
    } else if (f.roundLabel) {
      metaHtml =
        '<div style="font-size:10px;color:#64748b;margin-top:3px;">' +
        f.roundLabel +
        "</div>";
    }
    return (
      '<div style="padding:10px 12px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:13px;color:#e2e8f0;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
      "<span>" +
      cupTeamLink(f.homeName) +
      " " +
      scoreHtml +
      " " +
      cupTeamLink(f.awayName) +
      "</span>" +
      btn +
      "</div>" +
      metaHtml +
      "</div>"
    );
  }

  /** Eşleşme ağacı — sadece "played" sekmesi */
  async function renderServerCupTree() {
    const list = document.getElementById("fixturesHubList");
    if (!list) return;
    list.innerHTML =
      '<div style="color:#64748b;text-align:center;padding:12px;">Yükleniyor...</div>';
    try {
      const data = await fetchCupBracket();
      if (!data.edition) {
        list.innerHTML =
          '<div style="color:#64748b;text-align:center;padding:16px;">Kupa henüz oluşmadı.</div>';
        return;
      }
      const fixtures = data.bracket || [];
      const rounds = {};
      fixtures.forEach((f) => {
        (rounds[f.round] = rounds[f.round] || []).push(f);
      });
      const roundKeys = Object.keys(rounds)
        .map(Number)
        .sort((a, b) => a - b);

      function teamLine(name, goals, isWinner) {
        const nm = name || "TBD";
        const g =
          goals != null && goals !== ""
            ? '<b style="color:#facc15;min-width:16px;text-align:right;">' +
              goals +
              "</b>"
            : '<span style="color:#334155;min-width:16px;">·</span>';
        return (
          '<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 8px;' +
          (isWinner ? "background:rgba(74,222,128,0.08);border-radius:6px;" : "") +
          '"><span style="font-size:12px;color:' +
          (isWinner ? "#4ade80;font-weight:700" : "#e2e8f0") +
          ';">' +
          nm +
          "</span>" +
          g +
          "</div>"
        );
      }

      let html =
        '<div class="youth-section-title">🏅 Eşleşme Ağacı · ' +
        (data.edition.yearLabel || "") +
        "</div>" +
        '<div style="overflow-x:auto;padding-bottom:10px;"><div style="display:flex;align-items:stretch;gap:8px;min-width:min-content;">';

      roundKeys.forEach((rk, colIdx) => {
        const rf = rounds[rk];
        const label = (rf[0] && rf[0].roundLabel) || "Tur " + rk;
        html +=
          '<div style="display:flex;flex-direction:column;gap:12px;min-width:168px;">' +
          '<div style="text-align:center;font-size:11px;font-weight:700;color:#facc15;">' +
          label +
          "</div>";
        rf.forEach((f) => {
          if (f.id)
            cacheFixture({
              id: f.id,
              homeClubId: f.homeClubId,
              awayClubId: f.awayClubId,
            });
          const fin = f.status === "finished";
          const hw = fin && Number(f.homeGoals) > Number(f.awayGoals);
          const aw = fin && Number(f.awayGoals) > Number(f.homeGoals);
          html +=
            '<div style="background:#0f172a;border:1px solid #2c3a52;border-radius:10px;padding:6px;">' +
            teamLine(f.homeName, fin ? f.homeGoals : null, hw) +
            '<div style="height:1px;background:#1e293b;margin:2px 4px;"></div>' +
            teamLine(f.awayName, fin ? f.awayGoals : null, aw) +
            (f.status === "scheduled" || f.status === "live"
              ? '<button class="sub-btn" style="width:100%;margin-top:4px;padding:3px;font-size:10px;" onclick="watchFixture(\'' +
                f.id +
                "')\">" +
                (f.status === "live" ? "Canlı" : "İzle") +
                "</button>"
              : "") +
            "</div>";
        });
        html += "</div>";
        if (colIdx < roundKeys.length - 1)
          html +=
            '<div style="display:flex;align-items:center;color:#334155;font-size:18px;">›</div>';
      });
      html += "</div></div>";
      if (data.edition.championClubId) {
        html +=
          '<div style="text-align:center;margin-top:14px;padding:12px;border:1px solid #facc15;border-radius:12px;color:#facc15;font-weight:800;">🏆 Şampiyon belli</div>';
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:12px;">Kupa ağacı alınamadı.</div>';
    }
  }

  /** Fikstür — düz liste (tarihe göre) */
  async function renderServerCupFixtureList() {
    const list = document.getElementById("fixturesHubList");
    if (!list) return;
    list.innerHTML =
      '<div style="color:#64748b;text-align:center;padding:12px;">Yükleniyor...</div>';
    try {
      const data = await fetchCupBracket();
      if (!data.edition) {
        list.innerHTML =
          '<div style="color:#64748b;text-align:center;padding:16px;">Kupa henüz oluşmadı.</div>';
        return;
      }
      const fixtures = (data.bracket || [])
        .filter((f) => f.status !== "bye")
        .slice()
        .sort((a, b) => {
          const ta = a.kickoffAt ? new Date(a.kickoffAt).getTime() : 0;
          const tb = b.kickoffAt ? new Date(b.kickoffAt).getTime() : 0;
          return ta - tb;
        });
      let html =
        '<div class="youth-section-title">📅 Kupa Fikstürü · ' +
        (data.edition.yearLabel || "") +
        "</div>";
      if (!fixtures.length) {
        html +=
          '<div style="color:#64748b;text-align:center;padding:12px;">Maç yok.</div>';
      } else {
        const finished = fixtures.filter((f) => f.status === "finished");
        const upcoming = fixtures.filter((f) => f.status !== "finished");
        if (upcoming.length) {
          html +=
            '<div style="font-size:11px;color:#94a3b8;margin:8px 0 4px;">Oynanacak / canlı</div>';
          upcoming.forEach((f) => {
            html += cupMatchRow(f);
          });
        }
        if (finished.length) {
          html +=
            '<div style="font-size:11px;color:#94a3b8;margin:12px 0 4px;">Oynanan</div>';
          finished
            .slice()
            .reverse()
            .forEach((f) => {
              html += cupMatchRow(f);
            });
        }
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:12px;">Fikstür alınamadı.</div>';
    }
  }

  /** Krallık — biten maçlardan takım gol sıralaması */
  async function renderServerCupKings() {
    const list = document.getElementById("fixturesHubList");
    if (!list) return;
    list.innerHTML =
      '<div style="color:#64748b;text-align:center;padding:12px;">Yükleniyor...</div>';
    try {
      const data = await fetchCupBracket();
      const goals = {};
      (data.bracket || []).forEach((f) => {
        if (f.status !== "finished") return;
        if (f.homeName) {
          goals[f.homeName] = (goals[f.homeName] || 0) + (Number(f.homeGoals) || 0);
        }
        if (f.awayName) {
          goals[f.awayName] = (goals[f.awayName] || 0) + (Number(f.awayGoals) || 0);
        }
      });
      const ranked = Object.keys(goals)
        .map((n) => ({ name: n, g: goals[n] }))
        .sort((a, b) => b.g - a.g);
      let html =
        '<div class="youth-section-title">👑 Kupa Gol Krallığı (takım)</div>' +
        '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">Oyuncu bazlı kupa istatistiği yakında; şimdilik takım golleri.</div>';
      if (!ranked.length) {
        html +=
          '<div style="color:#64748b;text-align:center;padding:12px;">Henüz oynanmış kupa maçı yok.</div>';
      } else {
        ranked.forEach((r, i) => {
          html +=
            '<div style="display:flex;justify-content:space-between;padding:8px 10px;margin-bottom:4px;background:#0f172a;border:1px solid #2c3a52;border-radius:8px;font-size:13px;color:#e2e8f0;">' +
            "<span><b style=\"color:#38bdf8;\">" +
            (i + 1) +
            ".</b> " +
            r.name +
            "</span><b style=\"color:#4ade80;\">" +
            r.g +
            " gol</b></div>";
        });
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:12px;">Krallık alınamadı.</div>';
    }
  }

  /** Tarihçe */
  async function renderServerCupHistory() {
    const list = document.getElementById("fixturesHubList");
    if (!list) return;
    list.innerHTML =
      '<div style="color:#64748b;text-align:center;padding:12px;">Yükleniyor...</div>';
    try {
      const data = await fetchCupBracket();
      let html = '<div class="youth-section-title">📜 Kupa Tarihçesi</div>';
      if (data.edition && data.edition.championClubId) {
        const finals = (data.bracket || []).filter(
          (f) => f.status === "finished" && (f.roundLabel || "").toLowerCase().indexOf("final") >= 0,
        );
        let champ = "Şampiyon";
        if (finals.length) {
          const f = finals[finals.length - 1];
          if (Number(f.homeGoals) > Number(f.awayGoals)) champ = f.homeName;
          else if (Number(f.awayGoals) > Number(f.homeGoals)) champ = f.awayName;
        }
        html +=
          '<div style="padding:12px;margin-bottom:8px;background:#0f172a;border:1px solid #facc15;border-radius:12px;color:#e2e8f0;">' +
          "🏆 <b>Sezon " +
          (data.edition.yearLabel || "") +
          "</b><br><span style=\"color:#4ade80;font-size:15px;font-weight:700;\">" +
          champ +
          "</span></div>";
      } else {
        html +=
          '<div style="color:#64748b;padding:12px;text-align:center;">Bu sezonun şampiyonu henüz belli değil.</div>';
      }
      const finished = (data.bracket || []).filter((f) => f.status === "finished");
      if (finished.length) {
        html +=
          '<div style="font-size:11px;color:#94a3b8;margin:10px 0 4px;">Oynanan turlar</div>';
        finished.forEach((f) => {
          html +=
            '<div style="padding:8px 10px;margin-bottom:4px;background:#0f172a;border:1px solid #2c3a52;border-radius:8px;font-size:12px;color:#cbd5e1;">' +
            (f.roundLabel || "Tur") +
            ": " +
            (f.homeName || "") +
            " <b style=\"color:#facc15;\">" +
            f.homeGoals +
            "-" +
            f.awayGoals +
            "</b> " +
            (f.awayName || "") +
            "</div>";
        });
      }
      list.innerHTML = html;
    } catch (e) {
      list.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:12px;">Tarihçe alınamadı.</div>';
    }
  }

  async function renderServerCupPanel(sub) {
    const s = sub || "played";
    if (s === "played") return renderServerCupTree();
    if (s === "fixture") return renderServerCupFixtureList();
    if (s === "kings") return renderServerCupKings();
    if (s === "history") return renderServerCupHistory();
    return renderServerCupTree();
  }

  // geriye dönük isim
  async function renderServerCupBracket() {
    return renderServerCupPanel("played");
  }

  const _origShowCompSub = window.showCompSub;
  window.showCompSub = function (comp, sub) {
    if (comp === "cup") {
      _currentComp = "cup";
      _compSub = sub || "played";
      try {
        highlightCompSubtabs("#fixturesHubTabs", _compSub);
      } catch (e) {}
      renderServerCupPanel(_compSub);
      return;
    }
    if (typeof _origShowCompSub === "function")
      return _origShowCompSub.apply(this, arguments);
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
    const securityQuestion = (
      document.getElementById("regSecurityQuestion") || {}
    ).value?.trim();
    const securityAnswer = (
      document.getElementById("regSecurityAnswer") || {}
    ).value?.trim();
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
        body: JSON.stringify({
          username,
          password,
          teamName: username + " SK",
          securityQuestion: securityQuestion || null,
          securityAnswer: securityAnswer || null,
        }),
      });
      setToken(data.token);
      localStorage.setItem(CLUB_KEY, JSON.stringify(data.club || null));
      if (errorEl) errorEl.innerText = "";
      await afterServerLogin(data);
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Kayıt başarısız.";
    }
  }

  async function handleForgotFetchQuestion() {
    const username = (document.getElementById("forgotUsername") || {}).value?.trim();
    const errorEl = document.getElementById("forgotError");
    const box = document.getElementById("forgotQuestionBox");
    if (!username) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı gir.";
      return;
    }
    if (errorEl) errorEl.innerText = "";
    try {
      const data = await apiFetch(
        "/api/auth/security-question?username=" + encodeURIComponent(username),
        { method: "GET" },
      );
      document.getElementById("forgotQuestionText").innerText = data.question;
      if (box) box.classList.remove("hidden");
    } catch (e) {
      if (box) box.classList.add("hidden");
      if (errorEl) errorEl.innerText = e.message || "Soru alınamadı.";
    }
  }

  async function handleForgotReset() {
    const username = (document.getElementById("forgotUsername") || {}).value?.trim();
    const answer = (document.getElementById("forgotAnswer") || {}).value?.trim();
    const newPassword = (document.getElementById("forgotNewPassword") || {}).value;
    const errorEl = document.getElementById("forgotError");
    if (!username || !answer || !newPassword || newPassword.length < 6) {
      if (errorEl)
        errorEl.innerText = "Tüm alanları doldur (yeni şifre en az 6 karakter).";
      return;
    }
    if (errorEl) errorEl.innerText = "Sıfırlanıyor...";
    try {
      await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ username, answer, newPassword }),
      });
      if (errorEl) errorEl.innerText = "";
      alert("Şifren sıfırlandı, şimdi yeni şifreyle giriş yapabilirsin.");
      const loginU = document.getElementById("loginUsername");
      const loginP = document.getElementById("loginPassword");
      if (loginU) loginU.value = username;
      if (loginP) loginP.value = "";
      document.getElementById("showLoginFromForgot")?.click();
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Sıfırlama başarısız.";
    }
  }

  rewireButton("loginBtn", handleServerLogin);
  rewireButton("registerBtn", handleServerRegister);
  rewireButton("forgotFetchBtn", handleForgotFetchQuestion);
  rewireButton("forgotResetBtn", handleForgotReset);

  // Enter tuşuyla gönderme — form etiketi olmadığı için input'lara elle bağlıyoruz.
  function wireEnterSubmit(inputIds, handler) {
    inputIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handler();
        }
      });
    });
  }
  wireEnterSubmit(["loginUsername", "loginPassword"], handleServerLogin);
  wireEnterSubmit(["regUsername", "regEmail", "regPassword"], handleServerRegister);
  wireEnterSubmit(["forgotUsername"], handleForgotFetchQuestion);
  wireEnterSubmit(["forgotAnswer", "forgotNewPassword"], handleForgotReset);

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
    p.iAmHighest = !!L.iAmHighest;
    p.userHasBid = !!(L.iAmHighest || L.userHasBid || L.iHaveBid);
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
        try {
          p.userHasBid = true;
          p.highestBidder = "Sen";
          p.iAmHighest = true;
          p.currentBid = amount;
        } catch (e2) {}
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
      if (hours > 168) hours = 168; // max 7 gün
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
        switchPage("page-stadium");
        if (typeof showStadiumTab === "function") showStadiumTab("youth");
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

    window.trainSelectedPlayers = async function () {
      const note = document.getElementById("trainingResultNote");
      if (note)
        note.innerText =
          "Manuel antrenman kapalı. Skill artışı maç oynanınca otomatik verilir.";
      if (typeof pushNotification === "function")
        pushNotification(
          "ℹ️",
          "Antrenman otomatik: maç sonu skill artışı",
          "Antrenman",
        );
    };
    window.trainWholeSquadSameSkill = window.trainSelectedPlayers;

  // Elite isim değiştirme (sunucu)
  window.__emRenameStadiumServer = async function (name) {
    try {
      const res = await apiFetch("/api/stadium/rename", {
        method: "POST",
        body: JSON.stringify({ name: name }),
      });
      if (res && res.state) applyStadiumToClient(res.state);
    } catch (e) {
      console.warn("[em] stadium rename", e);
    }
  };
  window.__emRenameTeamServer = async function (name) {
    try {
      // Takım adını kaydet: mevcut team snapshot üzerine name yaz
      const t = await apiFetch("/api/team");
      if (t && t.team) {
        t.team.name = name;
        await apiFetch("/api/team", {
          method: "POST",
          body: JSON.stringify({ team: t.team }),
        });
      }
    } catch (e) {
      console.warn("[em] team rename", e);
    }
  };

  // Arama: sunucudan kullanıcı / oyuncu (basit)
  window.__emServerSearch = async function (q, tab) {
    if (!q || q.length < 2) return "";
    try {
      // Mesaj alıcı listesinden kullanıcı
      let html = "";
      if (tab === "all" || tab === "users") {
        const msg = await apiFetch("/api/messages");
        const rec = (msg && msg.recipients) || [];
        const hits = rec.filter(function (r) {
          const n = (r.username || r.name || "").toLowerCase();
          return n.indexOf(q) >= 0;
        });
        if (hits.length) {
          html +=
            '<div class="youth-section-title" style="margin-top:12px;">Sunucu kullanıcıları</div>';
          hits.slice(0, 20).forEach(function (r) {
            html +=
              '<div style="padding:10px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:13px;color:#e2e8f0;">👤 <b>' +
              (r.username || r.name) +
              "</b>" +
              (r.id
                ? ' <span style="color:#64748b;">· id: ' +
                  String(r.id).slice(0, 8) +
                  "</span>"
                : "") +
              "</div>";
          });
        }
      }
      return html;
    } catch (e) {
      return "";
    }
  };

    window.trainWholeTeamWithCoach = window.trainSelectedPlayers;

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
        if (typeof showStadiumTab === "function") showStadiumTab("facility");
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
    const canMod =
      typeof canModerateForum === "function" && canModerateForum();
    const hint = document.getElementById("forumModHint");
    if (hint) hint.style.display = canMod ? "block" : "none";
    if (!posts || !posts.length) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:8px;">Henüz gönderi yok.</div>';
      return;
    }
    list.innerHTML = posts
      .map(function (p, idx) {
        const safeUser =
          typeof adminAcEscape === "function"
            ? adminAcEscape(p.user || "?")
            : String(p.user || "?");
        const safeText =
          typeof adminAcEscape === "function"
            ? adminAcEscape(p.text || "")
            : String(p.text || "");
        return (
          '<div style="padding:12px;margin-bottom:8px;background:#0f172a;border:1px solid #2c3a52;border-radius:12px;">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><b style="color:#38bdf8;">' +
          safeUser +
          '</b><span style="color:#64748b;font-size:11px;">' +
          (p.time || "") +
          "</span></div>" +
          '<div style="color:#e2e8f0;font-size:13px;">' +
          safeText +
          (canMod
            ? '<div style="margin-top:6px;"><button type="button" class="sub-btn" style="width:auto;padding:2px 8px;font-size:10px;background:#7f1d1d;" onclick="deleteForumPostAt(' +
              idx +
              ')">Sil</button></div>'
            : "") +
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
                const safeUsername =
                  typeof adminAcEscape === "function"
                    ? adminAcEscape(u.username || u.userId)
                    : String(u.username || u.userId || "").replace(/"/g, "&quot;");
                return (
                  '<option value="' +
                  u.userId +
                  '" data-username="' +
                  safeUsername +
                  '">' +
                  safeUsername +
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
              const safeText =
                typeof adminAcEscape === "function"
                  ? adminAcEscape(n.text || "")
                  : String(n.text || "");
              return (
                '<div class="team-player-row"><span style="font-size:16px;margin-right:8px;">' +
                (n.icon || "🔔") +
                '</span><span style="flex:1;color:#cbd5e1;font-size:12.5px;">' +
                safeText +
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

  // ------------------------------------------------------------
  // Milli Takım (sunucu) — gerçek çağrı / ilk 11 / TD yönetimi
  // ------------------------------------------------------------
  const NAT_FORMATIONS = [
    "4-4-2", "4-3-3", "4-2-3-1", "3-5-2", "5-3-2", "4-1-4-1",
    "4-5-1", "3-4-3", "4-3-2-1", "3-4-2-1", "4-4-1-1", "5-4-1",
  ];
  // Kulüp taktik sayfasındaki (page-tactics) FORMATION_PRESETS ile birebir
  // aynı koordinatlar — aynı .formation-pitch-wrap / .formation-token CSS'i
  // kullanıyoruz, sadece sağdan-soldan çevirmeye gerek yok (tek taraf).
  const NAT_FORMATION_PRESETS = {
    "4-4-2": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "ML", x: 300, y: 55 },
      { pos: "MC", x: 300, y: 145 }, { pos: "MC", x: 300, y: 255 },
      { pos: "MR", x: 300, y: 345 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 345 },
    ],
    "4-3-3": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "MC", x: 300, y: 100 },
      { pos: "MC", x: 300, y: 200 }, { pos: "MC", x: 300, y: 300 },
      { pos: "FL", x: 490, y: 55 }, { pos: "FC", x: 510, y: 200 },
      { pos: "FR", x: 490, y: 345 },
    ],
    "4-2-3-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "DM", x: 210, y: 140 },
      { pos: "DM", x: 210, y: 260 }, { pos: "ML", x: 380, y: 60 },
      { pos: "OMC", x: 410, y: 200 }, { pos: "MR", x: 380, y: 340 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-5-2": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 40 }, { pos: "MC", x: 300, y: 120 },
      { pos: "DM", x: 220, y: 200 }, { pos: "MC", x: 300, y: 280 },
      { pos: "MR", x: 300, y: 360 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 345 },
    ],
    "5-3-2": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 115, y: 40 },
      { pos: "DC", x: 110, y: 115 }, { pos: "DC", x: 105, y: 200 },
      { pos: "DC", x: 110, y: 285 }, { pos: "DR", x: 115, y: 360 },
      { pos: "MC", x: 300, y: 110 }, { pos: "MC", x: 300, y: 200 },
      { pos: "MC", x: 300, y: 290 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 345 },
    ],
    "4-1-4-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "DM", x: 210, y: 200 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 140 },
      { pos: "MC", x: 300, y: 260 }, { pos: "MR", x: 300, y: 350 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "4-5-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "ML", x: 300, y: 45 },
      { pos: "MC", x: 300, y: 120 }, { pos: "DM", x: 220, y: 200 },
      { pos: "MC", x: 300, y: 280 }, { pos: "MR", x: 300, y: 355 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-4-3": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 350 },
      { pos: "FL", x: 490, y: 55 }, { pos: "FC", x: 510, y: 200 },
      { pos: "FR", x: 490, y: 345 },
    ],
    "4-3-2-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "MC", x: 300, y: 100 },
      { pos: "MC", x: 300, y: 200 }, { pos: "MC", x: 300, y: 300 },
      { pos: "OMC", x: 410, y: 140 }, { pos: "OMC", x: 410, y: 260 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-4-2-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 350 },
      { pos: "OMC", x: 410, y: 130 }, { pos: "OMC", x: 410, y: 270 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "4-4-1-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 350 }, { pos: "ML", x: 300, y: 55 },
      { pos: "MC", x: 300, y: 145 }, { pos: "MC", x: 300, y: 255 },
      { pos: "MR", x: 300, y: 345 }, { pos: "OMC", x: 410, y: 200 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "5-4-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 115, y: 40 },
      { pos: "DC", x: 110, y: 115 }, { pos: "DC", x: 105, y: 200 },
      { pos: "DC", x: 110, y: 285 }, { pos: "DR", x: 115, y: 360 },
      { pos: "ML", x: 300, y: 60 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 340 },
      { pos: "FC", x: 510, y: 200 },
    ],
  };

  let _natState = null;
  let _natCategory = "A"; // A | U21

  // Özel Taktikler: kulüp sayfasındaki (teamConfig.home.customTactics) ile
  // aynı checkbox listesi — milli/U21 için de sunucuya kaydedilmiyor,
  // sadece bu tarayıcıda saklanıyor (kulüpteki davranışla birebir aynı).
  const NAT_CUSTOM_TACTICS_KEY = "emNatCustomTactics_v1";
  function loadNatCustomTactics() {
    try {
      const raw = localStorage.getItem(NAT_CUSTOM_TACTICS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        A: Object.assign({}, parsed.A || {}),
        U21: Object.assign({}, parsed.U21 || {}),
      };
    } catch (e) {
      return { A: {}, U21: {} };
    }
  }
  let _natCustomTactics = loadNatCustomTactics();
  function saveNatCustomTactics() {
    try {
      localStorage.setItem(NAT_CUSTOM_TACTICS_KEY, JSON.stringify(_natCustomTactics));
    } catch (e) {}
  }
  window.setNatCustomTactic = function (key, checked) {
    if (!_natCustomTactics[_natCategory]) _natCustomTactics[_natCategory] = {};
    _natCustomTactics[_natCategory][key] = checked ? "aktif" : "pasif";
    saveNatCustomTactics();
  };

  // _natLineup: seçili formasyonun her slotu için { pos, x, y, playerId|null }
  let _natLineup = [];
  let _natFormation = "4-4-2";
  let _natPassStyle = "kisa";
  let _natGameStyle = "dengeli";
  let _natSelectedSlot = null; // sahada seçili boş/dolu slot index'i
  let _natApplications = [];
  // tactic | all | groups | rank | fixtures | kings | history | stats
  let _natManageSub = "tactic";
  let _tacticsMode = "club"; // "club" | "A" | "U21" — Taktikler ana sayfasındaki mod
  let _natPageSub = "groups"; // page-national alt sekmesi

  function syncNationalManageTabs() {
    const isU21 = _natCategory === "U21";
    const clubBtn = document.getElementById("tacticsModeClub");
    // Milli Takımlar bağlamında (A / U21) Kulüp sekmesi gizlenir;
    // Ana menü → Taktikler ile açılınca Kulüp sekmesi görünür.
    if (clubBtn) {
      const hideClub = _tacticsMode === "A" || _tacticsMode === "U21";
      clubBtn.style.display = hideClub ? "none" : "";
    }
    document.querySelectorAll(".tactics-mode-btn").forEach((btn) => {
      const active = btn.dataset.mode === _tacticsMode;
      btn.style.background = active ? "" : "#334155";
    });
    document.querySelectorAll(".nat-manage-subtab").forEach((btn) => {
      const active = btn.dataset.sub === _natManageSub;
      btn.classList.toggle("active", active);
      btn.style.background = active ? "" : "#334155";
    });
  }

  /** Taktikler ana sayfasında Kulüp / A Milli / U21 modu değiştirir. */
  window.setTacticsMode = async function (mode) {
    _tacticsMode = mode === "A" || mode === "U21" ? mode : "club";
    const clubView = document.getElementById("tacticsClubView");
    const natView = document.getElementById("tacticsNationalView");
    if (_tacticsMode === "club") {
      if (clubView) clubView.style.display = "";
      if (natView) natView.style.display = "none";
      syncNationalManageTabs();
      return;
    }
    if (clubView) clubView.style.display = "none";
    if (natView) natView.style.display = "";
    _natManageSub = "tactic";
    _natCategory = _tacticsMode;
    const body = document.getElementById("tacticsNatBody");
    if (body) {
      body.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
    }
    const state = await fetchNationalState(_natCategory);
    await fetchNationalApplicationsIfAdmin(state);
    syncNationalManageTabs();
    renderNationalManage();
  };

  function fmtNatOverall(n) {
    return Math.round(n);
  }

  /** Kulüp Kadro/Taktik sayfasındaki kalite rozetiyle aynı görsel dil:
   *  oyuncunun yeteneğini (overall) renkli emoji rozet olarak gösterir.
   *  "Çıkar" tuşunun yerine, milli/U21 taktik sayfasında bunu kullanıyoruz. */
  function natAbilityBadge(overall) {
    const v = Math.round(Number(overall) || 0);
    let emoji = "💫",
      color = "#f87171";
    if (v >= 14) {
      emoji = "🌟";
      color = "#4ade80";
    } else if (v >= 9) {
      emoji = "⭐";
      color = "#facc15";
    }
    return (
      '<span style="font-size:11px;font-weight:700;color:' +
      color +
      ';white-space:nowrap;" title="Yetenek: ' +
      v +
      '">' +
      emoji +
      " " +
      v +
      "</span>"
    );
  }

  /** Squad'daki mevcut ilk 11'i, formasyonun slotlarına en iyi eşleşmeyle yerleştirir. */
  function buildNationalLineupFromSquad(state, formation) {
    const template = NAT_FORMATION_PRESETS[formation] || NAT_FORMATION_PRESETS["4-4-2"];
    const starters = (state.squad || []).filter((p) => p.isStarter);
    const usedIds = new Set();
    const slots = template.map((slot) => ({ pos: slot.pos, x: slot.x, y: slot.y, playerId: null }));

    // 1) Kayıtlı atama mevkisi (pos) ile birebir eşleştir
    slots.forEach((slot) => {
      if (slot.playerId) return;
      const match = starters.find(
        (p) => !usedIds.has(p.playerId) && p.pos === slot.pos,
      );
      if (match) {
        slot.playerId = match.playerId;
        usedIds.add(match.playerId);
      }
    });
    // 2) Doğal mevki ile doldur
    slots.forEach((slot) => {
      if (slot.playerId) return;
      const match = starters.find(
        (p) => !usedIds.has(p.playerId) && p.naturalPos === slot.pos,
      );
      if (match) {
        slot.playerId = match.playerId;
        usedIds.add(match.playerId);
      }
    });
    // 3) Kalanlar sırayla
    const leftovers = starters.filter((p) => !usedIds.has(p.playerId));
    slots.forEach((slot) => {
      if (slot.playerId || !leftovers.length) return;
      const p = leftovers.shift();
      slot.playerId = p.playerId;
      usedIds.add(p.playerId);
    });
    return slots;
  }

  function natSquadPlayerById(playerId) {
    return (_natState?.squad || []).find((p) => p.playerId === playerId) || null;
  }

  async function fetchNationalState(category) {
    if (category) _natCategory = category === "U21" ? "U21" : "A";
    try {
      const state = await apiFetch(
        "/api/national/state?category=" + encodeURIComponent(_natCategory),
      );
      _natState = state;
      _natFormation = (state.team && state.team.formation) || "4-4-2";
      _natPassStyle = (state.team && state.team.passStyle) || "kisa";
      _natGameStyle = (state.team && state.team.gameStyle) || "dengeli";
      _natLineup = buildNationalLineupFromSquad(state, _natFormation);
      _natSelectedSlot = null;
      return state;
    } catch (e) {
      console.warn("[em] national state", e);
      return null;
    }
  }

  async function fetchNationalApplicationsIfAdmin(state) {
    if (!state || !state.isAdmin) {
      _natApplications = [];
      return;
    }
    try {
      const res = await apiFetch(
        "/api/national/applications?category=" + encodeURIComponent(_natCategory),
      );
      _natApplications = res.applications || [];
    } catch (e) {
      console.warn("[em] national applications", e);
      _natApplications = [];
    }
  }

  /** Ülke listesinden grup / sıralama satırları (A / U21). */

  const NAT_POT_KEY = "em_nat_pots_draw_v1";

  /** Sıralamaya göre 4 torba (1=en güçlü). */
  function getNationalPots(rows) {
    const sorted = (rows || []).slice().sort(function (a, b) {
      return (b.pts || 0) - (a.pts || 0);
    });
    const pots = [[], [], [], []];
    sorted.forEach(function (r, i) {
      const pot = Math.min(3, Math.floor(i / 4));
      pots[pot].push(Object.assign({}, r, { pot: pot + 1 }));
    });
    // Eksik doldur
    while (sorted.length < 16) {
      /* ignore */
      break;
    }
    return pots;
  }

  /** Torbalardan gruba kura: her gruba her torbadan 1. */
  function getNationalGroupDraw(rows) {
    try {
      const raw = localStorage.getItem(NAT_POT_KEY + "_" + (_natCategory || "A"));
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.groups && saved.groups.length === 4) {
          // isimleri güncel rows ile eşle
          const byC = {};
          (rows || []).forEach(function (r) {
            byC[r.c] = r;
          });
          return saved.groups.map(function (g) {
            return (g || []).map(function (name) {
              const r = byC[name] || { c: name, flag: "🏳️", pts: 0 };
              return Object.assign({}, r, {
                pot: saved.pots && saved.pots[name] ? saved.pots[name] : undefined,
              });
            });
          });
        }
      }
    } catch (e) {}
    return drawNationalGroupsFromPots(rows, false);
  }

  function drawNationalGroupsFromPots(rows, force) {
    const pots = getNationalPots(rows).map(function (p) {
      return p.slice();
    });
    // shuffle each pot
    pots.forEach(function (pot) {
      for (let i = pot.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pot[i];
        pot[i] = pot[j];
        pot[j] = t;
      }
    });
    const groups = [[], [], [], []];
    for (let potIdx = 0; potIdx < 4; potIdx++) {
      for (let g = 0; g < 4; g++) {
        const team = pots[potIdx][g];
        if (team) groups[g].push(team);
      }
    }
    // persist
    try {
      const potsMap = {};
      groups.forEach(function (g) {
        g.forEach(function (t) {
          potsMap[t.c] = t.pot;
        });
      });
      localStorage.setItem(
        NAT_POT_KEY + "_" + (_natCategory || "A"),
        JSON.stringify({
          groups: groups.map(function (g) {
            return g.map(function (t) {
              return t.c;
            });
          }),
          pots: potsMap,
          at: Date.now(),
        }),
      );
    } catch (e) {}
    return groups;
  }

  window.redrawNationalPots = function () {
    const rows = buildNatCountryRows(_natCategory === "U21" ? "U21" : "A");
    drawNationalGroupsFromPots(rows, true);
    if (typeof showNationalSub === "function") showNationalSub("groups");
    else if (typeof renderNationalPage === "function") renderNationalPage();
    else {
      // manage view
      try {
        if (typeof renderNationalInfoSub === "function")
          renderNationalInfoSub("groups");
      } catch (e) {}
      try {
        if (typeof showNationalManageSub === "function")
          showNationalManageSub(_natManageSub || "groups");
      } catch (e) {}
    }
  };

    function buildNatCountryRows(which) {
    const names =
      typeof COUNTRY_NAMES !== "undefined" && Array.isArray(COUNTRY_NAMES)
        ? COUNTRY_NAMES
        : ["Türkiye", "Almanya", "Fransa", "İspanya", "İngiltere", "İtalya", "Portekiz", "Hollanda", "Belçika", "Hırvatistan", "Polonya", "Danimarka", "İsviçre", "Avusturya", "İsveç", "Sırbistan"];
    const flagFn =
      typeof countryFlag === "function" ? countryFlag : function () { return "🏳️"; };
    const leagues =
      typeof worldLeagues !== "undefined" ? worldLeagues : null;
    return names
      .map((c) => {
        const teams =
          leagues && leagues[c] && leagues[c][1] ? leagues[c][1] : [];
        const pts = teams.reduce((s, t) => s + (t.pts || 0), 0);
        const strength = teams.length
          ? Math.round(
              teams.reduce((s, t) => s + (t.strength || 50), 0) / teams.length,
            )
          : 50 + Math.floor(Math.random() * 20);
        return {
          c,
          pts:
            which === "U21"
              ? Math.round(pts * 0.55 + strength)
              : pts + strength,
          strength,
          flag: flagFn(c),
        };
      })
      .sort((a, b) => b.pts - a.pts);
  }

  /**
   * Milli sayfa / yönet sekmeleri: groups, rank, fixtures, kings, history, stats, overview
   * targetEl'e HTML basar; showManageBtn true ise "Milli Takımı Yönet" ekler.
   */
  function renderNationalInfoContent(sub, targetEl, showManageBtn) {
    if (!targetEl) return;
    const which = _natCategory === "U21" ? "U21" : "A";
    const suffix = which === "U21" ? " U21" : "";
    const state = _natState;
    const rows = buildNatCountryRows(which);
    const card = (html) =>
      '<div style="padding:10px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:13px;color:#e2e8f0;">' +
      html +
      "</div>";

    let html = "";

    if (sub === "overview" || !sub) {
      if (!state || !state.team) {
        html =
          '<div style="color:#64748b;text-align:center;padding:12px;">Milli takım bilgisi alınamadı.</div>';
      } else {
        const t = state.team;
        html =
          '<div style="padding:12px;background:#0f172a;border:1px solid #2c3a52;border-radius:12px;margin-bottom:10px;">' +
          '<div style="font-size:15px;font-weight:700;color:#e2e8f0;">🏳️ ' +
          t.country +
          suffix +
          " Milli Takımı</div>";
        html += t.isMeManager
          ? '<div style="font-size:12px;color:#4ade80;margin-top:6px;">Teknik direktör sensin</div>'
          : t.isManagerVacant
            ? '<div style="font-size:12px;color:#94a3b8;margin-top:6px;">Teknik direktör koltuğu boş</div>'
            : '<div style="font-size:12px;color:#94a3b8;margin-top:6px;">Teknik Direktör: <b>' +
              (t.managerClubName || "?") +
              "</b></div>";
        if (state.nextFixture) {
          const d = new Date(state.nextFixture.kickoffAt);
          html +=
            '<div style="font-size:11px;color:#64748b;margin-top:6px;">Sıradaki maç: ' +
            state.nextFixture.opponentName +
            " · " +
            d.toLocaleString("tr-TR") +
            "</div>";
        }
        html += "</div>";
        if (state.recentFixtures && state.recentFixtures.length) {
          html += '<div class="youth-section-title">Son Sonuçlar</div>';
          html += state.recentFixtures
            .map(
              (f) =>
                card(
                  t.country +
                    " <b>" +
                    f.homeGoals +
                    "-" +
                    f.awayGoals +
                    "</b> " +
                    f.opponentName,
                ),
            )
            .join("");
        }
      }
        } else if (sub === "groups") {
      html =
        '<div class="youth-section-title">Elemeler — Gruplar' +
        suffix +
        "</div>";
      html +=
        '<div class="formation-hint" style="margin-bottom:8px;">Torba sistemi: sıralamaya göre 4 torba · her gruba her torbadan 1 takım. ' +
        '<button type="button" class="sub-btn" style="width:auto;padding:4px 10px;font-size:11px;margin-left:6px;" onclick="redrawNationalPots()">Yeniden kura</button></div>';
      // Torba görünümü
      const pots = getNationalPots(rows);
      html +=
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">';
      pots.forEach(function (pot, pi) {
        html +=
          '<div style="background:#0f172a;border:1px solid #2c3a52;border-radius:10px;padding:8px;">' +
          '<div style="font-size:11px;font-weight:800;color:#facc15;margin-bottom:4px;">Torba ' +
          (pi + 1) +
          "</div>";
        pot.forEach(function (r) {
          html +=
            '<div style="font-size:12px;color:#e2e8f0;padding:2px 0;">' +
            r.flag +
            " " +
            r.c +
            "</div>";
        });
        html += "</div>";
      });
      html += "</div>";
      // Gruplar (kura sonucu)
      const drawn = getNationalGroupDraw(rows);
      const groups = ["A", "B", "C", "D"];
      for (let g = 0; g < 4; g++) {
        html +=
          '<div style="font-size:12px;font-weight:700;color:#38bdf8;margin:10px 0 4px;">Grup ' +
          groups[g] +
          "</div>";
        const slice = drawn[g] || [];
        slice.forEach(function (r, i) {
          const p = [9, 7, 4, 1][i] || 0;
          html +=
            '<div class="clickable-player" onclick="openCountryProfile && openCountryProfile(\'' +
            r.c +
            '\')" style="padding:10px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:13px;color:#e2e8f0;cursor:pointer;">' +
            (i + 1) +
            ". " +
            r.flag +
            " " +
            r.c +
            suffix +
            ' · <span style="color:#64748b;font-size:11px;">T' +
            (r.pot || "?") +
            "</span> · <b>" +
            p +
            "</b> puan</div>";
        });
      }
    } else if (sub === "rank") {
      html =
        '<div class="youth-section-title">Milli Takım Sıralaması' +
        suffix +
        "</div>";
      rows.forEach((r, i) => {
        html +=
          '<div class="clickable-player" onclick="openCountryProfile && openCountryProfile(\'' +
          r.c +
          '\')" style="display:flex;justify-content:space-between;padding:8px 10px;margin-bottom:4px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:13px;color:#e2e8f0;cursor:pointer;">' +
          "<span>" +
          (i + 1) +
          ". " +
          r.flag +
          " " +
          r.c +
          suffix +
          '</span><b style="color:#facc15;">' +
          r.pts +
          " puan</b></div>";
      });
    } else if (sub === "fixtures") {
      html =
        '<div class="youth-section-title">Milli Maç Fikstürü' +
        suffix +
        '</div><div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">Perşembe 21:00 (TR)</div>';
      if (state && state.nextFixture) {
        const d = new Date(state.nextFixture.kickoffAt);
        html += card(
          '<span style="color:#38bdf8;">Sıradaki</span> · ' +
            (state.team ? state.team.country : "TR") +
            suffix +
            " vs <b>" +
            state.nextFixture.opponentName +
            "</b> · " +
            d.toLocaleString("tr-TR"),
        );
      }
      if (state && state.recentFixtures && state.recentFixtures.length) {
        html += '<div class="youth-section-title">Oynanan</div>';
        state.recentFixtures.forEach((f) => {
          html += card(
            (state.team ? state.team.country : "TR") +
              suffix +
              " <b style=\"color:#38bdf8;\">" +
              f.homeGoals +
              "-" +
              f.awayGoals +
              "</b> " +
              f.opponentName,
          );
        });
      }
      // Turnuva eşleşmeleri (gruplardan türetilmiş)
      html += '<div class="youth-section-title">Grup Maçları</div>';
      for (let i = 0; i < 8; i++) {
        const a = rows[i];
        const b = rows[rows.length - 1 - i];
        if (!a || !b || a.c === b.c) continue;
        const played = i < 3;
        const score = played ? (i % 3) + 1 + "-" + (i % 2) : "—";
        html += card(
          a.flag +
            " " +
            a.c +
            suffix +
            " <b style=\"color:" +
            (played ? "#38bdf8" : "#64748b") +
            ';">' +
            score +
            "</b> " +
            b.flag +
            " " +
            b.c +
            suffix +
            (played
              ? ' <span style="color:#64748b;font-size:11px;">(Oynandı)</span>'
              : ' <span style="color:#38bdf8;font-size:11px;">(Bekliyor)</span>'),
        );
      }
    } else if (sub === "kings") {
      html =
        '<div class="youth-section-title">Milli Gol / Asist Krallığı' +
        suffix +
        "</div>";
      html +=
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';
      html +=
        '<div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">⚽ Gol</div>';
      rows.slice(0, 8).forEach((r, i) => {
        html +=
          '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(51,65,85,0.3);font-size:12px;"><span>' +
          (i + 1) +
          ". " +
          r.c.split(" ")[0] +
          " Forvet" +
          ' <span style="color:#64748b;">(' +
          r.c +
          suffix +
          ')</span></span><b style="color:#4ade80;">' +
          (10 - i) +
          "</b></div>";
      });
      html +=
        '</div><div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">🎯 Asist</div>';
      rows.slice(0, 8).forEach((r, i) => {
        html +=
          '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(51,65,85,0.3);font-size:12px;"><span>' +
          (i + 1) +
          ". " +
          r.c.split(" ")[0] +
          " 10 Numara" +
          ' <span style="color:#64748b;">(' +
          r.c +
          suffix +
          ')</span></span><b style="color:#38bdf8;">' +
          (8 - Math.floor(i / 2)) +
          "</b></div>";
      });
      html += "</div></div>";
    } else if (sub === "history") {
      html = '<div class="youth-section-title">Tarihçe' + suffix + "</div>";
      const winners =
        which === "U21"
          ? [
              ["2024", "İspanya"],
              ["2023", "İngiltere"],
              ["2022", "Almanya"],
              ["2021", "Almanya"],
            ]
          : [
              ["2024", "Arjantin"],
              ["2022", "Arjantin"],
              ["2018", "Fransa"],
              ["2014", "Almanya"],
              ["2010", "İspanya"],
            ];
      winners.forEach((w, i) => {
        const seasonNo = winners.length - i;
        html += card(
          "🏆 <b>Sezon " +
            seasonNo +
            '</b> · Şampiyon: <span style="color:#facc15;">' +
            (typeof countryFlag === "function" ? countryFlag(w[1]) : "🏳️") +
            " " +
            w[1] +
            suffix +
            "</span>",
        );
      });
    } else if (sub === "stats") {
      html =
        '<div class="youth-section-title">📊 Milli Takım İstatistikleri' +
        suffix +
        "</div>";
      if (state && state.team) {
        const t = state.team;
        const squad = state.squad || [];
        const avgOvr = squad.length
          ? Math.round(
              squad.reduce((s, p) => s + (Number(p.overall) || 0), 0) /
                squad.length,
            )
          : 0;
        html += card(
          "<b>Ülke:</b> " +
            t.country +
            suffix +
            "<br><b>TD:</b> " +
            (t.isMeManager
              ? "Sensin"
              : t.isManagerVacant
                ? "Boş"
                : t.managerClubName || "?") +
            "<br><b>Kadro:</b> " +
            (state.squadSize || squad.length) +
            "/" +
            (state.maxSquad || 23) +
            "<br><b>Ortalama yetenek:</b> " +
            avgOvr +
            "<br><b>Formasyon:</b> " +
            (t.formation || _natFormation || "4-4-2") +
            "<br><b>Oyun stili:</b> " +
            (t.gameStyle || _natGameStyle || "dengeli"),
        );
        if (state.nextFixture) {
          const d = new Date(state.nextFixture.kickoffAt);
          html += card(
            "<b>Sıradaki maç:</b> " +
              state.nextFixture.opponentName +
              " · Güç " +
              (state.nextFixture.opponentStrength || "?") +
              "<br>" +
              d.toLocaleString("tr-TR"),
          );
        }
        if (state.recentFixtures && state.recentFixtures.length) {
          let w = 0,
            d0 = 0,
            l = 0,
            gf = 0,
            ga = 0;
          state.recentFixtures.forEach((f) => {
            const hg = Number(f.homeGoals) || 0;
            const ag = Number(f.awayGoals) || 0;
            gf += hg;
            ga += ag;
            if (hg > ag) w++;
            else if (hg === ag) d0++;
            else l++;
          });
          html += card(
            "<b>Son " +
              state.recentFixtures.length +
              " maç:</b> " +
              w +
              "G " +
              d0 +
              "B " +
              l +
              "M<br><b>Gol:</b> " +
              gf +
              " atılan · " +
              ga +
              " yenilen",
          );
        }
        if (squad.length) {
          html += '<div class="youth-section-title">Kadrodaki Oyuncular</div>';
          squad
            .slice()
            .sort((a, b) => (b.overall || 0) - (a.overall || 0))
            .forEach((p) => {
              html +=
                '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.25);font-size:12px;color:#e2e8f0;"><span>' +
                (p.isStarter ? "⭐ " : "") +
                p.name +
                " · " +
                p.pos +
                ' <span style="color:#94a3b8;">(' +
                (p.clubName || "-") +
                ')</span></span><b style="color:#facc15;">' +
                Math.round(p.overall || 0) +
                "</b></div>";
            });
        }
      } else {
        html +=
          '<div style="color:#64748b;text-align:center;padding:12px;">İstatistik için milli takım verisi yüklenemedi.</div>';
      }
    } else {
      html =
        '<div style="color:#64748b;text-align:center;padding:12px;">Bu sekme henüz hazır değil.</div>';
    }

    if (showManageBtn) {
      html +=
        '<button class="sub-btn" style="width:100%;margin-top:12px;" onclick="goToNationalManage()">Milli Takımı Yönet</button>';
    }
    targetEl.innerHTML = html;
  }

  function renderNationalOverview(state) {
    const list = document.getElementById("nationalTeamsList");
    if (!list) return;
    _natState = state || _natState;
    // Aktif alt sekmeyi koru (groups varsayılan)
    const sub = _natPageSub || "groups";
    if (sub === "kit") {
      if (typeof natKitEditorHtml === "function") {
        list.innerHTML = natKitEditorHtml();
        if (typeof refreshKitAccessFor === "function")
          refreshKitAccessFor("natKit", "national");
      }
      return;
    }
    renderNationalInfoContent(sub, list, true);
  }

  function renderNationalManage() {
    const info = document.getElementById("tacticsNatInfo");
    const squadEl = document.getElementById("tacticsNatBody");
    if (!info || !squadEl || !_natState) return;
    const state = _natState;
    const t = state.team;

    let infoHtml =
      '<div style="font-size:15px;font-weight:700;color:#e2e8f0;">🏳️ ' +
      t.country +
      " Milli Takımı</div>";
    if (t.isMeManager) {
      infoHtml +=
        '<div style="font-size:12px;color:#4ade80;margin-top:6px;">Teknik Direktör: Sensin</div>' +
        '<button class="sub-btn" style="margin-top:8px;" onclick="resignNationalManager()">Görevi Bırak</button>';
    } else if (state.myApplication) {
      infoHtml +=
        '<div style="font-size:12px;color:#fbbf24;margin-top:6px;">Başvurun admin onayını bekliyor</div>' +
        '<button class="sub-btn" style="margin-top:8px;" onclick="withdrawNationalApplication()">Başvuruyu Geri Çek</button>';
    } else {
      infoHtml +=
        '<div style="font-size:12px;color:#94a3b8;margin-top:6px;">' +
        (t.isManagerVacant
          ? "Koltuk boş"
          : "Teknik Direktör: <b>" + (t.managerClubName || "?") + "</b>") +
        "</div>" +
        '<button class="sub-btn" style="margin-top:8px;" onclick="applyNationalManager()">Teknik Direktörlüğe Başvur</button>';
    }

    if (state.isAdmin) {
      infoHtml += '<div class="youth-section-title" style="margin-top:10px;">Başvurular (Admin)</div>';
      infoHtml += _natApplications.length
        ? _natApplications
            .map(
              (a) =>
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.25);font-size:12px;color:#e2e8f0;">' +
                "<span>" +
                a.username +
                (a.clubName ? " · " + a.clubName : "") +
                (a.message
                  ? '<br><span style="color:#64748b;font-size:11px;">' + a.message + "</span>"
                  : "") +
                "</span>" +
                '<button style="font-size:10px;padding:3px 6px;white-space:nowrap;" onclick="appointNationalManager(' +
                a.id +
                ')">Ata</button></div>',
            )
            .join("")
        : '<div style="color:#64748b;font-size:12px;padding:6px 0;">Bekleyen başvuru yok.</div>';
    }
    if (state.nextFixture) {
      const d = new Date(state.nextFixture.kickoffAt);
      infoHtml +=
        '<div style="font-size:11px;color:#64748b;margin-top:8px;">Sıradaki maç: ' +
        state.nextFixture.opponentName +
        " · " +
        d.toLocaleString("tr-TR") +
        "</div>";
    }
    infoHtml +=
      '<div style="font-size:11px;color:#64748b;margin-top:4px;">Kadro: ' +
      state.squadSize +
      "/" +
      state.maxSquad +
      " · İlk 11 seçili: " +
      _natLineup.filter((s) => s.playerId).length +
      "/11</div>";
    info.innerHTML = infoHtml;

    let html = "";
    const infoSubs = {
      groups: 1,
      rank: 1,
      fixtures: 1,
      kings: 1,
      history: 1,
      stats: 1,
    };
    const sub = infoSubs[_natManageSub]
      ? _natManageSub
      : _natManageSub === "all"
        ? "all"
        : "tactic";

    // Gruplar / Sıralama / Fikstür / Krallık / Tarihçe / İstatistik
    // Yönet ekranında da aynı sekmeler aktif kalır (kaybolmaz).
    if (infoSubs[sub]) {
      renderNationalInfoContent(sub, squadEl, false);
      return;
    }

    if (sub === "all") {
      // -------- Seçilenler: kadroya çağrılmış oyuncular, sayfanın en başında --------
      const squad = state.squad || [];
      html +=
        '<div class="youth-section-title">⭐ Seçilenler (' +
        squad.length +
        "/" +
        state.maxSquad +
        ")</div>";
      html += squad.length
        ? '<div style="margin-bottom:14px;">' +
          squad
            .map(
              (p) =>
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(74,222,128,0.25);font-size:12px;color:#e2e8f0;">' +
                "<span>⭐ " +
                p.name +
                " · " +
                p.pos +
                ' <span style="color:#94a3b8;">(' +
                p.clubName +
                ", " +
                fmtNatOverall(p.overall) +
                ")</span></span>" +
                natAbilityBadge(p.overall) +
                "</div>",
            )
            .join("") +
          "</div>"
        : '<div style="color:#64748b;font-size:12px;padding:0 0 10px;">Henüz seçilen oyuncu yok — aşağıdaki listeden seç.</div>';

      if (t.isMeManager && squad.length > 0) {
        html +=
          '<button class="sub-btn" style="width:100%;margin-bottom:14px;" onclick="showNationalManageSub(\'tactic\')">📋 Kadroyu Açıkla</button>';
      }

      // -------- Tüm Oyuncular: kalite sırasına göre (en iyi üstte) tam aday havuzu --------
      const pool = state.candidates || []; // backend zaten overall DESC sıralıyor
      html +=
        '<div class="formation-hint">Kadroya henüz çağrılmamış tüm ' +
        (t.country || "") +
        (_natCategory === "U21" ? " U21" : " A") +
        " uygun oyuncular — kaliteye göre en iyi en üstte.</div>";
      if (!t.isMeManager) {
        html +=
          '<div style="color:#94a3b8;font-size:12px;padding:8px 0;">Oyuncu çağırmak için bu takımın teknik direktörü olman gerekiyor.</div>';
      }
      html += pool.length
        ? '<div class="youth-section-title">Tüm Oyuncular (' + pool.length + ")</div>" +
          pool
            .map(
              (p) =>
                '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.25);font-size:12px;color:#e2e8f0;">' +
                '<span class="clickable-player" style="flex:1;cursor:pointer;" onclick="openNationalCandidateProfile(\'' +
                String(p.playerId || "").replace(/'/g, "") +
                '\')">' +
                p.name +
                " · " +
                p.pos +
                ' <span style="color:#94a3b8;">(' +
                p.clubName +
                ")</span></span>" +
                '<span style="display:flex;align-items:center;gap:8px;">' +
                natAbilityBadge(p.overall) +
                (t.isMeManager
                  ? '<button style="font-size:10px;padding:3px 6px;" onclick="event.stopPropagation();callUpNationalPlayer(\'' +
                    p.playerId +
                    '\')">Seç</button>'
                  : "") +
                "</span></div>",
            )
            .join("")
        : '<div style="color:#64748b;font-size:12px;padding:8px;">Uygun aday oyuncu bulunamadı.</div>';

      squadEl.innerHTML = html;
      return;
    }

    if (t.isMeManager) {
      // -------- Diziliş sahası (club page-tactics ile aynı görsel dil) --------
      html +=
        '<div class="tactics-title" style="margin-top:4px;">Diziliş — Tıkla ve Yerleştir</div>' +
        '<div class="formation-hint">Oyuncuya tıkla → kaleci hariç tüm boş bölgeler görünür, hedef bölgeye tıkla taşınır (doluysa yer değişir). Ya da bir bölgeye tıkla, sonra aşağıdaki kadrodan bir oyuncuya tıkla — o bölgeye yerleşir.</div>' +
        '<div class="formation-presets-row">' +
        NAT_FORMATIONS.map(
          (f) =>
            '<button class="formation-preset-btn' +
            (f === _natFormation ? " active" : "") +
            '" onclick="setNationalFormation(\'' +
            f +
            "')\">" +
            f +
            "</button>",
        ).join("") +
        "</div>" +
        '<div class="formation-pitch-wrap">' +
        '<div class="pitch-outer-border"></div>' +
        '<div class="pitch-halfway-line"></div>' +
        '<div class="pitch-center-circle"></div>' +
        '<div class="pitch-center-dot"></div>' +
        '<div class="pitch-box pitch-box-left"></div>' +
        '<div class="pitch-box pitch-box-right"></div>' +
        '<div class="pitch-tokens-layer">' +
        (_natSelectedSlot !== null
          ? PITCH_ZONES.filter((z) => {
              if (String(z.pos).toUpperCase() === "GK") return false;
              return !_natLineup.some((s) => s.x === z.x && s.y === z.y);
            })
              .map(
                (z) =>
                  '<div class="formation-token" style="left:' +
                  (z.x * 0.5 - 13) +
                  "px;top:" +
                  (z.y * 0.5 - 13) +
                  'px;background:rgba(15,23,42,0.55);border:1.5px dashed #facc15;color:#facc15;font-size:8px;font-weight:700;box-shadow:0 0 10px rgba(250,204,21,0.35);cursor:pointer;" onclick="handleNationalPitchClick(\'zone\',-1,' +
                  z.x +
                  "," +
                  z.y +
                  ",'" +
                  z.pos +
                  '\')" title="Buraya taşı: ' +
                  z.pos +
                  '">' +
                  z.pos +
                  "</div>",
              )
              .join("")
          : "") +
        _natLineup
          .map((slot, i) => {
            const p = slot.playerId ? natSquadPlayerById(slot.playerId) : null;
            const left = slot.x * 0.5 - 13;
            const top = slot.y * 0.5 - 13;
            const labelLeft = slot.x * 0.5 - 28;
            const labelTop = slot.y * 0.5 + 13;
            const cls = "formation-token " + slot.pos.toLowerCase();
            const sel = _natSelectedSlot === i ? " selected" : "";
            const inner = p ? p.name.split(" ").slice(-1)[0][0] + (p.name.split(" ").slice(-1)[0][1] || "") : slot.pos;
            const label = p ? p.name.split(" ").slice(-1)[0] + " · " + slot.pos : "Boş · " + slot.pos;
            return (
              '<div class="' +
              cls +
              sel +
              '" style="left:' +
              left +
              "px;top:" +
              top +
              'px;" onclick="handleNationalPitchClick(\'slot\',' +
              i +
              ')" title="' +
              (p ? p.name + " · " + slot.pos : "Boş bölge: " + slot.pos) +
              '">' +
              inner +
              "</div>" +
              '<div class="formation-token-label" style="left:' +
              labelLeft +
              "px;top:" +
              labelTop +
              'px;">' +
              label +
              "</div>"
            );
          })
          .join("") +
        "</div></div>";

      html += '<div class="youth-section-title" style="margin-top:6px;">Özel Taktikler</div>';
      html += (typeof TACTIC_LABELS !== "undefined" ? Object.keys(TACTIC_LABELS) : [])
        .map((key) => {
          const natTactics = _natCustomTactics[_natCategory] || {};
          const isActive = natTactics[key] === "aktif";
          return (
            '<div class="tactic-toggle" style="justify-content:space-between;">' +
            '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;">' +
            '<input type="checkbox"' +
            (isActive ? " checked" : "") +
            ' onchange="setNatCustomTactic(\'' +
            key +
            "', this.checked)\">" +
            "<span>" +
            TACTIC_LABELS[key] +
            "</span></label>" +
            '<button type="button" title="Nasıl kazanılır?" onclick="showTacticInfo(\'' +
            key +
            '\')" style="background:transparent;border:1px solid #334155;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:13px;color:#94a3b8;">ℹ️</button>' +
            "</div>"
          );
        })
        .join("");

      html +=
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0 10px;padding-top:12px;border-top:1px solid #2c3a52;">' +
        '<div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Pas Stili</div>' +
        '<select style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;" onchange="_natPassStyle=this.value">' +
        ["kisa", "uzun", "hizli", "karisik"]
          .map(
            (v) =>
              '<option value="' +
              v +
              '"' +
              (v === _natPassStyle ? " selected" : "") +
              ">" +
              (v === "kisa"
                ? "Kısa Pas"
                : v === "uzun"
                  ? "Uzun Pas"
                  : v === "hizli"
                    ? "Hızlı Pas"
                    : "Karışık Pas") +
              "</option>",
          )
          .join("") +
        "</select></div>" +
        '<div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Oyun Stili</div>' +
        '<select style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;" onchange="_natGameStyle=this.value">' +
        [
          ["dengeli", "Dengeli"],
          ["hücumsel", "Hücum"],
          ["defansif", "Defans"],
        ]
          .map(
            ([v, label]) =>
              '<option value="' +
              v +
              '"' +
              (v === _natGameStyle ? " selected" : "") +
              ">" +
              label +
              "</option>",
          )
          .join("") +
        "</select></div></div>";
    }

    html += (state.squad || []).length
      ? '<div class="youth-section-title">Kadro' +
        (t.isMeManager && _natSelectedSlot !== null
          ? ' <span style="color:#facc15;font-weight:400;font-size:11px;">— yerleştirmek için bir oyuncuya tıkla</span>'
          : "") +
        "</div>" +
        state.squad
          .map((p) => {
            const slotIdx = _natLineup.findIndex((s) => s.playerId === p.playerId);
            const isSel = slotIdx !== -1;
            const badge = isSel
              ? '<span style="color:#4ade80;font-size:10px;">İLK11 · ' + _natLineup[slotIdx].pos + "</span>"
              : '<span style="color:#64748b;font-size:10px;">YEDEK</span>';
            const controls = natAbilityBadge(p.overall);
            const rowClick = t.isMeManager
              ? ' onclick="placeNationalPlayer(\'' + p.playerId + '\')" style="cursor:pointer;"'
              : "";
            return (
              '<div' +
              rowClick +
              ' style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.35);font-size:12px;color:#e2e8f0;' +
              (rowClick ? "cursor:pointer;" : "") +
              '">' +
              "<span>" +
              p.name +
              " · " +
              p.pos +
              ' <span style="color:#94a3b8;">(' +
              p.clubName +
              ", " +
              fmtNatOverall(p.overall) +
              ')</span></span><span style="display:flex;gap:6px;align-items:center;white-space:nowrap;" onclick="event.stopPropagation()">' +
              badge +
              controls +
              "</span></div>"
            );
          })
          .join("")
      : '<div style="color:#64748b;font-size:12px;padding:8px;">Henüz çağrılmış oyuncu yok.</div>';

    if (t.isMeManager) {
      html +=
        '<div class="formation-hint" style="margin-top:6px;">Kadroya oyuncu eklemek için <b>👥 Tüm Oyuncular</b> sekmesine geç.</div>';
      html +=
        '<button class="sub-btn" style="width:100%;margin-top:12px;" onclick="saveNationalLineupClick()">İlk 11, Taktik &amp; Formasyonu Kaydet</button>';
    }

    squadEl.innerHTML = html;
  }

  window.goToNationalTeams = async function () {
    hideMainMenuAndShowBack();
    switchPage("page-national");
    // A sekmesi aktif görünsün
    const tabA = document.getElementById("natTabA");
    const tabU21 = document.getElementById("natTabU21");
    if (tabA) tabA.style.background = "";
    if (tabU21) tabU21.style.background = "#334155";
    const state = await fetchNationalState("A");
    renderNationalOverview(state);
  };
  window.showNationalTab = async function (which) {
    const tabA = document.getElementById("natTabA");
    const tabU21 = document.getElementById("natTabU21");
    const isU21 = which === "U21";
    if (tabA) tabA.style.background = isU21 ? "#334155" : "";
    if (tabU21) tabU21.style.background = isU21 ? "" : "#334155";
    _natCategory = isU21 ? "U21" : "A";
    // Alt sekmeleri vurgula
    document.querySelectorAll("#nationalSubTabs .nat-subtab").forEach((b) => {
      const on = b.getAttribute("data-sub") === (_natPageSub || "groups");
      b.style.background = on ? "" : "#334155";
      b.classList.toggle("active", on);
    });
    const list = document.getElementById("nationalTeamsList");
    if (list) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
    }
    const state = await fetchNationalState(isU21 ? "U21" : "A");
    renderNationalOverview(state);
  };
  window.showNationalSub = function (sub) {
    if (sub) _natPageSub = sub;
    // Sekme vurgusu
    document.querySelectorAll("#nationalSubTabs .nat-subtab").forEach((b) => {
      const on = b.getAttribute("data-sub") === (_natPageSub || "groups");
      b.style.background = on ? "" : "#334155";
      b.classList.toggle("active", on);
    });
    const list = document.getElementById("nationalTeamsList");
    if (!list) return;
    if (_natPageSub === "kit") {
      if (typeof natKitEditorHtml === "function") {
        list.innerHTML = natKitEditorHtml();
        if (typeof refreshKitAccessFor === "function")
          refreshKitAccessFor("natKit", "national");
      }
      return;
    }
    // State yoksa önce yükle
    if (!_natState) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
      fetchNationalState(_natCategory).then((st) => {
        renderNationalOverview(st);
      });
      return;
    }
    renderNationalOverview(_natState);
  };

  window.goToNationalManage = async function () {
    hideMainMenuAndShowBack();
    switchPage("page-tactics");
    // Yönet ekranında da aynı alt sekmeler erişilebilir kalsın
    _natManageSub = "tactic";
    await window.setTacticsMode(_natCategory === "U21" ? "U21" : "A");
  };
  window.showNationalManageSub = function (sub) {
    const allowed = {
      tactic: 1,
      all: 1,
      groups: 1,
      rank: 1,
      fixtures: 1,
      kings: 1,
      history: 1,
      stats: 1,
    };
    _natManageSub = allowed[sub] ? sub : "tactic";
    syncNationalManageTabs();
    renderNationalManage();
  };

  window.applyNationalManager = async function () {
    try {
      await apiFetch("/api/national/apply", { method: "POST", body: JSON.stringify({ category: _natCategory }) });
      const state = await fetchNationalState();
      await fetchNationalApplicationsIfAdmin(state);
      renderNationalManage();
    } catch (e) {
      alert(e.message || "Başvuru gönderilemedi");
    }
  };
  window.withdrawNationalApplication = async function () {
    try {
      await apiFetch("/api/national/apply/withdraw", { method: "POST", body: JSON.stringify({ category: _natCategory }) });
      const state = await fetchNationalState();
      await fetchNationalApplicationsIfAdmin(state);
      renderNationalManage();
    } catch (e) {
      alert(e.message || "İşlem başarısız");
    }
  };
  window.appointNationalManager = async function (applicationId) {
    if (!confirm("Bu kullanıcıyı teknik direktör olarak atamak istediğine emin misin? Kadro sıfırlanır.")) return;
    try {
      await apiFetch("/api/national/appoint", {
        method: "POST",
        body: JSON.stringify({ applicationId: applicationId, category: _natCategory }),
      });
      const state = await fetchNationalState();
      await fetchNationalApplicationsIfAdmin(state);
      renderNationalManage();
    } catch (e) {
      alert(e.message || "Atama başarısız");
    }
  };
  window.resignNationalManager = async function () {
    if (!confirm("Teknik direktörlüğü bırakmak istediğine emin misin? Kadro sıfırlanır.")) return;
    try {
      await apiFetch("/api/national/resign", { method: "POST", body: JSON.stringify({ category: _natCategory }) });
      const state = await fetchNationalState();
      await fetchNationalApplicationsIfAdmin(state);
      renderNationalManage();
    } catch (e) {
      alert(e.message || "İşlem başarısız");
    }
  };
  window.openNationalCandidateProfile = function (playerId) {
    const state = _natState;
    if (!state) return;
    const pool = (state.candidates || []).concat(state.squad || []);
    const p = pool.find(function (x) {
      return String(x.playerId) === String(playerId);
    });
    if (!p) return;
    const fake = {
      id: p.playerId,
      name: p.name,
      pos: p.pos,
      number: p.number || "?",
      age: p.age || 22,
      overall: p.overall,
      baseQuality: Math.max(1, Math.min(10, Math.round((p.overall || 10) / 2))),
      basePotential: Math.max(1, Math.min(10, Math.round((p.overall || 10) / 2))),
      condition: p.condition || 85,
      goals: p.goals || 0,
      assists: p.assists || 0,
      saves: 0,
      pace: p.pace || 10,
      passing: p.passing || 10,
      finishing: p.finishing || 10,
      tackle: p.tackle || 10,
      vision: p.vision || 10,
      stamina: p.stamina || 10,
      strength: p.strength || 10,
      technique: p.technique || 10,
      agility: p.agility || 10,
      positioning: p.positioning || 10,
      reflex: p.reflex || 10,
      handling: p.handling || 10,
    };
    if (typeof showPlayerProfile === "function")
      showPlayerProfile(fake, p.clubName || (state.team && state.team.country) || "Milli");
  };

  window.callUpNationalPlayer = async function (playerId) {

    try {
      await apiFetch("/api/national/squad/call", {
        method: "POST",
        body: JSON.stringify({ playerId: playerId, category: _natCategory }),
      });
      await fetchNationalState();
      renderNationalManage();
      const body = document.getElementById("tacticsNatBody");
      if (body && body.scrollIntoView) body.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      alert(e.message || "Çağrı başarısız");
    }
  };
  window.dropNationalPlayer = async function (playerId) {
    try {
      await apiFetch("/api/national/squad/drop", {
        method: "POST",
        body: JSON.stringify({ playerId: playerId, category: _natCategory }),
      });
      await fetchNationalState();
      renderNationalManage();
    } catch (e) {
      alert(e.message || "İşlem başarısız");
    }
  };
  window.setNationalFormation = function (formation) {
    _natFormation = formation;
    // Mevcut yerleşimi koru: aynı oyuncuları yeni formasyonun slotlarına
    // en iyi eşleşmeyle tekrar dağıt (kulüp sayfasındaki applyFormationPreset ruhu).
    const template = NAT_FORMATION_PRESETS[formation] || NAT_FORMATION_PRESETS["4-4-2"];
    const currentPlayers = _natLineup.filter((s) => s.playerId).map((s) => s.playerId);
    const usedIds = new Set();
    const slots = template.map((slot) => ({ pos: slot.pos, x: slot.x, y: slot.y, playerId: null }));
    slots.forEach((slot) => {
      const pid = currentPlayers.find((id) => {
        if (usedIds.has(id)) return false;
        const p = natSquadPlayerById(id);
        return p && (p.naturalPos === slot.pos);
      });
      if (pid) {
        slot.playerId = pid;
        usedIds.add(pid);
      }
    });
    const leftovers = currentPlayers.filter((id) => !usedIds.has(id));
    slots.forEach((slot) => {
      if (slot.playerId || !leftovers.length) return;
      const pid = leftovers.shift();
      slot.playerId = pid;
      usedIds.add(pid);
    });
    _natLineup = slots;
    _natSelectedSlot = null;
    renderNationalManage();
  };
  /** Verilen mevkinin bandındaki (kanat hariç) merkez oyuncuları kulüp
   *  taktik sayfasındaki gibi ortala ve eşit mesafeye yay. Tek oyuncu
   *  kalırsa onu tam ortaya (y=200) alır. Kaleci/kanat bantlarını es geçer. */
  function rebalanceNatCenterBand(pos) {
    const cp = String(pos || "").toUpperCase();
    if (!["FC", "MC", "DC", "DM", "OMC"].includes(cp)) return;
    if (typeof getZoneBand !== "function") return;
    const band = getZoneBand(cp);
    const wingKeys = ["DL", "DR", "ML", "MR", "FL", "FR"];
    const centers = _natLineup.filter(
      (s) =>
        s &&
        getZoneBand(s.pos) === band &&
        !wingKeys.includes(String(s.pos).toUpperCase()),
    );
    if (centers.length === 0) return;
    const bandX = centers[0].x;
    if (centers.length === 1) {
      centers[0].y = 200;
      centers[0].x = bandX;
      return;
    }
    centers.sort((a, b) => (a.y || 0) - (b.y || 0));
    const gap = Math.max(36, Math.min(55, Math.floor(140 / (centers.length - 1))));
    const total = gap * (centers.length - 1);
    const base = 200 - total / 2;
    centers.forEach((c, i) => {
      c.y = base + i * gap;
      c.x = bandX;
    });
  }
  /** Mevcut dizilişte (kaleci hariç) hat bazında oyuncu sayısını döner. */
  function natLineCounts() {
    let def = 0,
      mid = 0,
      fw = 0;
    _natLineup.forEach((s) => {
      if (!s) return;
      const band = typeof getZoneBand === "function" ? getZoneBand(s.pos) : null;
      if (band === "DF") def++;
      else if (band === "FW") fw++;
      else if (band && band !== "GK") mid++;
    });
    return { def, mid, fw };
  }

  /** Bir mevkinin hangi hatta (def/mid/fw) sayıldığını döner, kaleci/tanımsız için null. */
  function natLineCategory(pos) {
    const band = typeof getZoneBand === "function" ? getZoneBand(pos) : null;
    if (band === "DF") return "def";
    if (band === "FW") return "fw";
    if (band && band !== "GK") return "mid";
    return null;
  }

  // Diziliş kuralı: en az 3 defans, 2 orta saha, 1 forvet olmalı — daha aza izin verilmez.
  const NAT_MIN_LINE_COUNTS = { def: 3, mid: 2, fw: 1 };

  window.handleNationalPitchClick = function (kind, index, zx, zy, zpos) {
    if (_natSelectedSlot === null) {
      if (kind === "slot") {
        _natSelectedSlot = index;
        renderNationalManage();
      }
      return;
    }
    if (kind === "slot") {
      if (index === _natSelectedSlot) {
        _natSelectedSlot = null;
        renderNationalManage();
        return;
      }
      // İki dolu/boş bölge arasında oyuncu takası
      const a = _natLineup[_natSelectedSlot];
      const b = _natLineup[index];
      const tmp = a.playerId;
      a.playerId = b.playerId;
      b.playerId = tmp;
      _natSelectedSlot = null;
      renderNationalManage();
      return;
    }
    // kind === "zone": seçili bölgeyi (ve varsa oyuncusunu) boş hedef bölgeye taşı
    const slot = _natLineup[_natSelectedSlot];
    const fromPos = slot.pos;
    // Taşımadan önce: hedef hat kuralını ihlal eder mi kontrol et (en az 3 def/2 orta/1 forvet).
    const fromCat = natLineCategory(fromPos);
    const toCat = natLineCategory(zpos);
    if (fromCat !== toCat) {
      const projected = natLineCounts();
      if (fromCat) projected[fromCat]--;
      if (toCat) projected[toCat]++;
      if (
        projected.def < NAT_MIN_LINE_COUNTS.def ||
        projected.mid < NAT_MIN_LINE_COUNTS.mid ||
        projected.fw < NAT_MIN_LINE_COUNTS.fw
      ) {
        alert(
          "Diziliş kuralı: en az " +
            NAT_MIN_LINE_COUNTS.def +
            " defans, " +
            NAT_MIN_LINE_COUNTS.mid +
            " orta saha, " +
            NAT_MIN_LINE_COUNTS.fw +
            " forvet olmalı.",
        );
        _natSelectedSlot = null;
        renderNationalManage();
        return;
      }
    }
    slot.x = zx;
    slot.y = zy;
    slot.pos = zpos;
    // Kulüp taktik sayfasındaki gibi: merkez banttaki (kanat hariç) oyuncuları
    // ortala ve eşit mesafeye yay. Hem oyuncunun geldiği banttan (tek kalan
    // oyuncu varsa onu da tam ortaya alır) hem de gittiği bandı güncelle.
    rebalanceNatCenterBand(fromPos);
    rebalanceNatCenterBand(zpos);
    _natSelectedSlot = null;
    renderNationalManage();
  };
  window.placeNationalPlayer = function (playerId) {
    if (_natSelectedSlot === null) {
      alert("Önce sahada bir bölgeye tıkla, sonra oyuncuyu seç.");
      return;
    }
    const targetIdx = _natSelectedSlot;
    // Bu oyuncu zaten başka bir slottaysa, iki slotun oyuncusunu takas et.
    const fromIdx = _natLineup.findIndex((s) => s.playerId === playerId);
    if (fromIdx !== -1 && fromIdx !== targetIdx) {
      const tmp = _natLineup[targetIdx].playerId;
      _natLineup[targetIdx].playerId = playerId;
      _natLineup[fromIdx].playerId = tmp;
    } else if (fromIdx === -1) {
      _natLineup[targetIdx].playerId = playerId;
    }
    _natSelectedSlot = null;
    renderNationalManage();
  };
  window.saveNationalLineupClick = async function () {
    const starterPlayerIds = _natLineup.filter((s) => s.playerId).map((s) => s.playerId);
    const assignments = _natLineup
      .filter((s) => s.playerId)
      .map((s) => ({ playerId: s.playerId, pos: s.pos }));
    // Elle seçilen saha dizilimini koru (kaydet sonrası yeniden dağıtma)
    const lockedLineup = _natLineup.map(function (sl) {
      return {
        pos: sl.pos,
        x: sl.x,
        y: sl.y,
        playerId: sl.playerId || null,
      };
    });
    const lockedFormation = _natFormation;
    const lockedPass = _natPassStyle;
    const lockedGame = _natGameStyle;
    try {
      await apiFetch("/api/national/squad/lineup", {
        method: "POST",
        body: JSON.stringify({
          starterPlayerIds,
          formation: lockedFormation,
          assignments,
          passStyle: lockedPass,
          gameStyle: lockedGame,
          category: _natCategory,
        }),
      });
      // State'i güncelle ama lineup'ı şablondan yeniden kurma
      try {
        const state = await apiFetch(
          "/api/national/state?category=" + encodeURIComponent(_natCategory),
        );
        _natState = state;
      } catch (e) {}
      _natFormation = lockedFormation;
      _natPassStyle = lockedPass;
      _natGameStyle = lockedGame;
      _natLineup = lockedLineup;
      _natSelectedSlot = null;
      renderNationalManage();
      alert("Kaydedildi — saha dizilimi korundu");
    } catch (e) {
      alert(e.message || "Kaydedilemedi");
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
  rewireInMatchControls();
  tryAutoLogin();
})();


  window.__emSaveClubTeamServer = async function (team) {
    try {
      if (!team) return;
      await apiFetch("/api/team", {
        method: "POST",
        body: JSON.stringify({
          team: {
            name: team.name,
            players: team.players,
            bench: team.bench,
            gameStyle: team.gameStyle,
            passStyle: team.passStyle,
            attackDir: team.attackDir,
            formation: team.currentFormation || team.formation || "4-4-2",
            currentFormation: team.currentFormation || team.formation || "4-4-2",
          },
        }),
      });
    } catch (e) {
      console.warn("[em] save club team", e);
    }
  };


  // ============================================================
  // Elite — sunucu abonelik + ödeme
  // ============================================================
  window.__emPurchaseElite = async function (plan) {
    const note = document.getElementById("premiumPayNote");
    try {
      if (note) note.innerText = "Ödeme hazırlanıyor…";
      const res = await apiFetch("/api/premium/checkout", {
        method: "POST",
        body: JSON.stringify({
          plan: plan,
          successUrl: window.location.origin + window.location.pathname,
          cancelUrl: window.location.origin + window.location.pathname,
        }),
      });
      if (res.checkoutUrl) {
        if (note) note.innerText = "Stripe ödeme sayfasına yönlendiriliyorsun…";
        window.location.href = res.checkoutUrl;
        return;
      }
      if (res.mock) {
        if (
          !confirm(
            "Demo ödeme: " +
              plan +
              " planı sunucuda aktif edilsin mi?\n(Gerçek ortamda Stripe Checkout açılır.)",
          )
        ) {
          if (note) note.innerText = "İptal edildi.";
          return;
        }
        const conf = await apiFetch("/api/premium/confirm-mock", {
          method: "POST",
          body: JSON.stringify({ plan: plan }),
        });
        if (conf && conf.status && typeof applyPremiumFromServer === "function") {
          applyPremiumFromServer(conf.status);
        }
        if (conf && conf.status && conf.status.active) {
          try {
            if (typeof unlockSecondTeamSlot === "function") unlockSecondTeamSlot();
          } catch (e) {}
          if (typeof pushNotification === "function")
            pushNotification("⭐", "Elite üyelik sunucuda aktif", "Üyelik");
        }
        if (typeof renderPremiumPage === "function") renderPremiumPage();
        if (note)
          note.innerText = conf.status && conf.status.active
            ? "Elite aktif · sunucu kaydı tamam"
            : "Onay tamamlandı";
        return;
      }
      if (note) note.innerText = (res && res.error) || "Ödeme başlatılamadı";
      alert((res && res.error) || "Ödeme başlatılamadı");
    } catch (e) {
      if (note) note.innerText = e.message || "Ödeme hatası";
      alert(e.message || "Ödeme hatası");
    }
  };

  window.__emSyncEliteFromServer = async function () {
    try {
      const data = await apiFetch("/api/premium/status");
      if (data && data.status && typeof applyPremiumFromServer === "function") {
        applyPremiumFromServer(data.status);
      }
      return data;
    } catch (e) {
      console.warn("[em] elite sync", e);
      return null;
    }
  };

  // Giriş sonrası Elite senkron
  const _afterLoginElite = afterServerLogin;
  afterServerLogin = async function (data) {
    await _afterLoginElite(data);
    try {
      if (data && data.elite && typeof applyPremiumFromServer === "function") {
        applyPremiumFromServer(data.elite);
      } else if (typeof window.__emSyncEliteFromServer === "function") {
        await window.__emSyncEliteFromServer();
      }
      try {
        if (typeof getPremiumStatus === "function" && getPremiumStatus().active) {
          if (typeof unlockSecondTeamSlot === "function") unlockSecondTeamSlot();
        }
      } catch (e) {}
    } catch (e) {
      console.warn("[em] elite after login", e);
    }
  };

  // URL ?elite=success → durumu yenile
  try {
    const q = new URLSearchParams(window.location.search || "");
    if (q.get("elite") === "success") {
      setTimeout(async function () {
        await window.__emSyncEliteFromServer();
        if (typeof renderPremiumPage === "function") renderPremiumPage();
        if (typeof pushNotification === "function")
          pushNotification("⭐", "Ödeme alındı · Elite aktif", "Üyelik");
        // query temizle
        try {
          const u = new URL(window.location.href);
          u.searchParams.delete("elite");
          u.searchParams.delete("plan");
          window.history.replaceState({}, "", u.pathname + u.search);
        } catch (e) {}
      }, 400);
    }
  } catch (e) {}


  // Elite korumalı sunucu işlemleri
  window.__emSaveKitServer = async function (kit) {
    try {
      const res = await apiFetch("/api/premium/kit", {
        method: "POST",
        body: JSON.stringify({ kit: kit }),
      });
      return !!(res && res.ok);
    } catch (e) {
      console.warn("[em] kit save", e);
      if (e && (e.code === "ELITE_REQUIRED" || (e.message || "").indexOf("Elite") >= 0)) {
        if (typeof pushNotification === "function")
          pushNotification("⭐", "Kulüp forma için Elite üyelik gerekli", "Elite");
      }
      return false;
    }
  };

  window.__emLoadKitServer = async function () {
    try {
      const res = await apiFetch("/api/premium/kit");
      if (res && res.kit && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(
            "em_kit_club_" + String(managerName || "guest").toLowerCase(),
            JSON.stringify(res.kit),
          );
        } catch (e) {}
      }
      return res;
    } catch (e) {
      return null;
    }
  };

  window.__emSaveSecondTeamServer = async function (data) {
    try {
      const res = await apiFetch("/api/premium/second-team", {
        method: "POST",
        body: JSON.stringify({ secondTeam: data }),
      });
      return !!(res && res.ok);
    } catch (e) {
      console.warn("[em] second team", e);
      return false;
    }
  };

  window.__emClaimDailyRewardServer = async function () {
    try {
      const res = await apiFetch("/api/premium/daily-reward", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res && res.ok && res.balance != null && typeof clubBudget !== "undefined") {
        clubBudget = res.balance;
        try {
          if (typeof updateBudgetUI === "function") updateBudgetUI();
        } catch (e) {}
      }
      return res;
    } catch (e) {
      console.warn("[em] daily reward", e);
      throw e;
    }
  };

  // rename team via dedicated elite endpoint
  const _renameTeam = window.__emRenameTeamServer;
  window.__emRenameTeamServer = async function (name) {
    try {
      const res = await apiFetch("/api/premium/rename-club", {
        method: "POST",
        body: JSON.stringify({ name: name }),
      });
      if (res && res.ok) return res;
    } catch (e) {
      console.warn("[em] rename club elite", e);
      if (typeof pushNotification === "function")
        pushNotification("⭐", e.message || "Takım adı için Elite gerekli", "Elite");
      throw e;
    }
    if (typeof _renameTeam === "function") return _renameTeam(name);
  };

  // after login load kit
  try {
    const _al = afterServerLogin;
    afterServerLogin = async function (data) {
      await _al(data);
      try {
        await window.__emLoadKitServer();
      } catch (e) {}
    };
  } catch (e) {}


  // ============================================================
  // Admin Anti-Cheat UI
  // ============================================================
  window.__emServerAdmin = false;
  window.__emIsServerAdmin = function () {
    return !!window.__emServerAdmin;
  };

  async function __emDetectAdmin() {
    try {
      // national state carries isAdmin for ADMIN_USERNAME
      const cat = typeof _natCategory !== "undefined" ? _natCategory : "A";
      const state = await apiFetch(
        "/api/national/state?category=" + encodeURIComponent(cat),
      );
      window.__emServerAdmin = !!(state && state.isAdmin);
    } catch (e) {
      window.__emServerAdmin = false;
    }
    return window.__emServerAdmin;
  }

  window.__emAdminAcRefresh = async function () {
    const sum = document.getElementById("adminAcSummary");
    const logsEl = document.getElementById("adminAcLogs");
    try {
      await __emDetectAdmin();
      if (!window.__emServerAdmin) {
        if (sum) sum.innerText = "Admin yetkisi yok.";
        const ac = document.getElementById("adminAntiCheatPanel");
        if (ac) ac.style.display = "none";
        return;
      }
      const ac = document.getElementById("adminAntiCheatPanel");
      if (ac) ac.style.display = "block";

      const [summary, logs] = await Promise.all([
        apiFetch("/api/admin/anti-cheat/summary"),
        apiFetch("/api/admin/anti-cheat/logs?limit=40"),
      ]);

      if (sum) {
        const by = (summary && summary.last24h && summary.last24h.byAction) || [];
        const top = (summary && summary.last24h && summary.last24h.topUsers) || [];
        let html =
          '<div style="margin-bottom:6px;"><b style="color:#fbbf24;">Son 24 saat</b></div>';
        if (!by.length) html += '<div style="color:#64748b;">Olay yok.</div>';
        else
          html += by
            .map(
              (a) =>
                '<div>• <code style="color:#38bdf8;">' +
                (typeof adminAcEscape === "function" ? adminAcEscape(a.action) : a.action) +
                "</code> × " +
                a.cnt +
                "</div>",
            )
            .join("");
        if (top.length) {
          html +=
            '<div style="margin-top:8px;"><b style="color:#fbbf24;">En çok bayrak</b></div>';
          html += top
            .map(
              (u) =>
                '<div style="display:flex;justify-content:space-between;gap:8px;">' +
                '<span>' +
                (typeof adminAcEscape === "function"
                  ? adminAcEscape(u.username || "#" + u.userId)
                  : u.username || u.userId) +
                (u.is_banned ? ' <span style="color:#f87171;">[ban]</span>' : "") +
                "</span><span style=\"color:#94a3b8;\">" +
                u.count +
                "</span></div>",
            )
            .join("");
        }
        sum.innerHTML = html;
      }

      if (logsEl) {
        const list = (logs && logs.logs) || [];
        if (!list.length) {
          logsEl.innerHTML =
            '<div style="padding:10px;color:#64748b;">Log yok.</div>';
        } else {
          logsEl.innerHTML = list
            .map(function (L) {
              const t = L.created_at
                ? new Date(L.created_at).toLocaleString("tr-TR")
                : "";
              const det =
                typeof L.detail === "object"
                  ? JSON.stringify(L.detail).slice(0, 120)
                  : String(L.detail || "").slice(0, 120);
              return (
                '<div style="padding:8px 10px;border-bottom:1px solid #1e293b;">' +
                '<div style="color:#64748b;">' +
                t +
                " · uid " +
                (L.user_id || "—") +
                '</div>' +
                '<div><b style="color:#fbbf24;">' +
                (typeof adminAcEscape === "function"
                  ? adminAcEscape(L.action)
                  : L.action) +
                "</b></div>" +
                '<div style="color:#94a3b8;word-break:break-all;">' +
                (typeof adminAcEscape === "function" ? adminAcEscape(det) : det) +
                "</div></div>"
              );
            })
            .join("");
        }
      }
    } catch (e) {
      if (sum)
        sum.innerText = "Yüklenemedi: " + (e.message || e);
    }
  };

  window.__emAdminAcBanned = async function () {
    const logsEl = document.getElementById("adminAcLogs");
    try {
      const data = await apiFetch("/api/admin/banned");
      const users = (data && data.users) || [];
      if (logsEl) {
        if (!users.length) {
          logsEl.innerHTML =
            '<div style="padding:10px;color:#64748b;">Banlı kullanıcı yok.</div>';
        } else {
          logsEl.innerHTML = users
            .map(function (u) {
              return (
                '<div style="padding:8px 10px;border-bottom:1px solid #1e293b;">' +
                "<b style=\"color:#f87171;\">" +
                (typeof adminAcEscape === "function"
                  ? adminAcEscape(u.username)
                  : u.username) +
                "</b> · " +
                (u.banned_until
                  ? "bitiş " + new Date(u.banned_until).toLocaleString("tr-TR")
                  : "süresiz") +
                '<div style="color:#94a3b8;">' +
                (typeof adminAcEscape === "function"
                  ? adminAcEscape(u.ban_reason || "")
                  : u.ban_reason || "") +
                "</div></div>"
              );
            })
            .join("");
        }
      }
    } catch (e) {
      alert(e.message || "Liste alınamadı");
    }
  };

  window.__emAdminAcBan = async function () {
    const target = (document.getElementById("adminBanUser") || {}).value;
    const hoursRaw = (document.getElementById("adminBanHours") || {}).value;
    const reason = (document.getElementById("adminBanReason") || {}).value;
    if (!target || !String(target).trim()) {
      alert("Kullanıcı adı veya id gir.");
      return;
    }
    const body = {
      target: String(target).trim(),
      reason: String(reason || "Admin ban").trim(),
    };
    if (hoursRaw !== "" && hoursRaw != null) {
      const h = Number(hoursRaw);
      if (h > 0) body.hours = h;
    }
    if (
      !confirm(
        (body.hours ? body.hours + " saat " : "Süresiz ") +
          "ban: " +
          body.target +
          " ?",
      )
    )
      return;
    try {
      const res = await apiFetch("/api/admin/ban", {
        method: "POST",
        body: JSON.stringify(body),
      });
      alert("Ban uygulandı: " + (res.username || body.target));
      if (typeof window.__emAdminAcRefresh === "function")
        window.__emAdminAcRefresh();
    } catch (e) {
      alert(e.message || "Ban başarısız");
    }
  };

  window.__emAdminAcUnban = async function () {
    const target = (document.getElementById("adminBanUser") || {}).value;
    if (!target || !String(target).trim()) {
      alert("Kullanıcı adı veya id gir.");
      return;
    }
    if (!confirm("Unban: " + target + " ?")) return;
    try {
      const res = await apiFetch("/api/admin/unban", {
        method: "POST",
        body: JSON.stringify({ target: String(target).trim() }),
      });
      alert("Unban: " + (res.username || target));
      if (typeof window.__emAdminAcRefresh === "function")
        window.__emAdminAcRefresh();
    } catch (e) {
      alert(e.message || "Unban başarısız");
    }
  };

  window.__emAdminAcLookup = async function () {
    const target = (document.getElementById("adminBanUser") || {}).value;
    const box = document.getElementById("adminAcUserBox");
    if (!target || !String(target).trim()) {
      alert("Kullanıcı adı veya id gir.");
      return;
    }
    try {
      const data = await apiFetch(
        "/api/admin/user/" + encodeURIComponent(String(target).trim()),
      );
      const u = data.user || {};
      const club = data.club;
      if (box) {
        box.innerHTML =
          "<b style=\"color:#e2e8f0;\">" +
          (typeof adminAcEscape === "function"
            ? adminAcEscape(u.username)
            : u.username) +
          "</b> · id " +
          u.id +
          (u.banned || u.is_banned
            ? ' <span style="color:#f87171;">BANNED</span>'
            : ' <span style="color:#4ade80;">aktif</span>') +
          (u.ban_reason
            ? "<div>Sebep: " +
              (typeof adminAcEscape === "function"
                ? adminAcEscape(u.ban_reason)
                : u.ban_reason) +
              "</div>"
            : "") +
          (club
            ? "<div>Kulüp: " +
              (typeof adminAcEscape === "function"
                ? adminAcEscape(club.name)
                : club.name) +
              " · " +
              (club.balance != null ? club.balance : "") +
              "</div>"
            : "");
      }
      const logsEl = document.getElementById("adminAcLogs");
      const list = data.recentLogs || [];
      if (logsEl) {
        logsEl.innerHTML = list.length
          ? list
              .map(function (L) {
                const det =
                  typeof L.detail === "object"
                    ? JSON.stringify(L.detail).slice(0, 140)
                    : String(L.detail || "");
                return (
                  '<div style="padding:8px 10px;border-bottom:1px solid #1e293b;"><b style="color:#fbbf24;">' +
                  (typeof adminAcEscape === "function"
                    ? adminAcEscape(L.action)
                    : L.action) +
                  "</b><div style=\"color:#94a3b8;\">" +
                  (typeof adminAcEscape === "function" ? adminAcEscape(det) : det) +
                  "</div></div>"
                );
              })
              .join("")
          : '<div style="padding:10px;color:#64748b;">Bu kullanıcı için log yok.</div>';
      }
    } catch (e) {
      if (box) box.innerText = e.message || "Bulunamadı";
    }
  };

  // Login sonrası admin panel görünürlüğü
  try {
    const _al2 = afterServerLogin;
    afterServerLogin = async function (data) {
      await _al2(data);
      try {
        await __emDetectAdmin();
      } catch (e) {}
    };
  } catch (e) {}
