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
  function resolveApiBase() {
    try {
      if (window.EM_API_BASE != null && String(window.EM_API_BASE).length)
        return String(window.EM_API_BASE).replace(/\/$/, "");
    } catch (e) {}
    try {
      if (
        !window.location ||
        window.location.protocol === "file:" ||
        window.location.protocol === "app:"
      ) {
        return "http://localhost:3000";
      }
    } catch (e2) {}
    return "";
  }
  const API_BASE = resolveApiBase();
  const TOKEN_KEY = "em_jwt_token";
  const CLUB_KEY = "em_club_info";
  let socket = null;
  /** Canlı maçta bu kullanıcının tarafı (home/away) — iki insanlı maç için */
  let _emMyMatchSide = null;
  let _emSyncHeartbeat = null;
  let _emNextFixture = null;
  let _emFixtureCache = {}; // fixtureId -> fixture (homeClubId/awayClubId dahil)
  let _emMySide = null; // "home" | "away" | null — izlenen maçta hangi taraftayım
  let _emInmatchPanelShown = false;

  // GÜVENLİK: kulüp adı, oyuncu adı, TD başvuru mesajı gibi kullanıcı
  // tarafından belirlenebilen tüm metinler innerHTML ile DOM'a yazılmadan
  // önce HTML-escape edilmeli. Aksi halde bir kullanıcı kulübüne
  // "<img src=x onerror=...>" gibi bir isim vererek diğer tüm oyuncuların
  // tarayıcısında script çalıştırabilir (saklı/stored XSS). index.html
  // içindeki adminAcEscape ile aynı mantık; burada da global olarak
  // kullanılabilmesi için ayrıca tanımlanır.
  function escapeHtml(t) {
    return String(t == null ? "" : t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  window.emEscapeHtml = escapeHtml;

  function cacheFixture(f) {
    if (f && f.id) _emFixtureCache[f.id] = f;
  }

  function determineMySide(fixtureId) {
    const f = _emFixtureCache[fixtureId];
    if (!f) return null;
    const myId = _emMyClub && _emMyClub.id != null ? String(_emMyClub.id) : null;
    if (myId) {
      if (f.homeClubId != null && String(f.homeClubId) === myId) return "home";
      if (f.awayClubId != null && String(f.awayClubId) === myId) return "away";
    }
    // Son çare: kullanıcı adı eşleşmesi
    try {
      const uname = String(
        (typeof managerName !== "undefined" && managerName) ||
          localStorage.getItem("em_username") ||
          "",
      ).toLowerCase();
      if (uname) {
        if (String(f.homeName || "").toLowerCase().indexOf(uname) >= 0) return "home";
        if (String(f.awayName || "").toLowerCase().indexOf(uname) >= 0) return "away";
      }
    } catch (e) {}
    return null;
  }
  let _emMyClub = null;
  let _emPlayerIdCounter = 1;

  const REFRESH_TOKEN_KEY = "em_jwt_refresh";
  let _emRefreshPromise = null;
  let _emRefreshTimer = null;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }
  function getRefreshToken() {
    try {
      return localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch (e) {
      return null;
    }
  }
  function setRefreshToken(t) {
    try {
      if (t) localStorage.setItem(REFRESH_TOKEN_KEY, t);
      else localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch (e) {}
  }
  function applyAuthTokens(data) {
    if (!data) return;
    const access = data.accessToken || data.token;
    if (access) setToken(access);
    if (data.refreshToken) setRefreshToken(data.refreshToken);
    scheduleProactiveRefresh(data.expiresIn);
    // Socket auth güncelle
    try {
      if (typeof socket !== "undefined" && socket && socket.auth) {
        socket.auth.token = getToken();
      }
    } catch (e) {}
  }
  function scheduleProactiveRefresh(expiresInSec) {
    try {
      if (_emRefreshTimer) clearTimeout(_emRefreshTimer);
      let ms = null;
      if (expiresInSec && Number(expiresInSec) > 60) {
        // Süre dolmadan ~90 sn önce yenile
        ms = (Number(expiresInSec) - 90) * 1000;
      } else {
        // Token exp claim
        const tok = getToken();
        if (tok) {
          const parts = tok.split(".");
          if (parts.length >= 2) {
            const payload = JSON.parse(
              atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
            );
            if (payload && payload.exp) {
              ms = payload.exp * 1000 - Date.now() - 90 * 1000;
            }
          }
        }
      }
      if (ms != null && ms > 5000) {
        _emRefreshTimer = setTimeout(function () {
          refreshAccessToken().catch(function () {});
        }, ms);
      }
    } catch (e) {}
  }
  async function refreshAccessToken() {
    if (_emRefreshPromise) return _emRefreshPromise;
    const rt = getRefreshToken();
    if (!rt) return null;
    _emRefreshPromise = (async function () {
      try {
        const res = await fetch(API_BASE + "/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: rt }),
        });
        let data = null;
        try {
          data = await res.json();
        } catch (e) {}
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            // TOKEN_REVOKED / ban / expire → tam çıkış
            forceClientLogout(
              (data && data.code) || "SESSION_END",
              (data && data.error) || null,
            );
          }
          return null;
        }
        applyAuthTokens(data);
        return data.accessToken || data.token || null;
      } catch (e) {
        return null;
      } finally {
        _emRefreshPromise = null;
      }
    })();
    return _emRefreshPromise;
  }
  window.__emRefreshAccessToken = refreshAccessToken;

  /** Şifre sıfırlama / ban / logout-all sonrası istemci oturumunu temizle */
  function forceClientLogout(code, message) {
    try {
      setToken(null);
      setRefreshToken(null);
      if (_emRefreshTimer) clearTimeout(_emRefreshTimer);
      _emRefreshTimer = null;
    } catch (e) {}
    try {
      if (typeof socket !== "undefined" && socket) {
        if (socket.auth) socket.auth.token = null;
        // Yeniden bağlanınca misafir olur
      }
    } catch (e2) {}
    try {
      if (code === "TOKEN_REVOKED" || code === "BANNED" || code === "ACCOUNT_DELETED" || code === "EMAIL_NOT_VERIFIED" || code === "ACCOUNT_LOCKED") {
        const msg =
          message ||
          (code === "BANNED"
            ? "Hesabınız engellenmiş."
            : "Oturumunuz sonlandırıldı. Tekrar giriş yapın.");
        if (typeof window.__emOnSessionEnd === "function") {
          window.__emOnSessionEnd({ code: code, message: msg });
        } else if (typeof alert === "function") {
          // Sessiz tekrarları azalt
          if (!window.__emSessionEndAlerted) {
            window.__emSessionEndAlerted = true;
            alert(msg);
            setTimeout(function () {
              window.__emSessionEndAlerted = false;
            }, 5000);
          }
        }
      }
    } catch (e3) {}
  }
  window.__emForceClientLogout = forceClientLogout;

  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {},
    );
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    let res;
    try {
      res = await fetch(
        API_BASE + path,
        Object.assign({}, opts, { headers }),
      );
    } catch (netErr) {
      throw new Error(
        "Sunucuya ulaşılamadı. node server.js çalıştırın" +
          (API_BASE ? " · " + API_BASE : "") +
          (window.location && window.location.protocol === "file:"
            ? " · file:// yerine http://localhost:PORT kullan"
            : ""),
      );
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    // İptal edilmiş oturum — refresh deneme
    if (
      res.status === 401 &&
      data &&
      (data.code === "TOKEN_REVOKED" || data.code === "BANNED" || data.code === "ACCOUNT_DELETED" || data.code === "EMAIL_NOT_VERIFIED" || data.code === "ACCOUNT_LOCKED")
    ) {
      forceClientLogout(data.code, data.error);
      throw new Error(data.error || "Oturum sonlandı");
    }
    // 401 → bir kez refresh dene (login/register/refresh hariç)
    if (
      res.status === 401 &&
      !opts._retried &&
      path.indexOf("/api/auth/login") < 0 &&
      path.indexOf("/api/auth/register") < 0 &&
      path.indexOf("/api/auth/refresh") < 0 &&
      path.indexOf("/api/auth/logout-all") < 0
    ) {
      const newTok = await refreshAccessToken();
      if (newTok) {
        return apiFetch(path, Object.assign({}, opts, { _retried: true }));
      }
      forceClientLogout("SESSION_END", (data && data.error) || null);
    }
    if (!res.ok) {
      if (data && data.code === "MAINTENANCE") {
        try {
          if (typeof window.__emSetMaintenance === "function") {
            window.__emSetMaintenance(true, data.error || data.message);
          }
        } catch (eM) {}
      }
      const msg =
        (data && data.error) ||
        (res.status === 401 || res.status === 403
          ? "Oturum gerekli — tekrar giriş yap"
          : "HTTP " + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.code = data && data.code;
      err.payload = data || null;
      err.retryAfterMs =
        (data && data.retryAfterMs) ||
        (data && data.locked_until
          ? Math.max(0, new Date(data.locked_until).getTime() - Date.now())
          : null);
      throw err;
    }
    return data;
  }

  window.apiFetch = apiFetch;
  window.__emApiFetchReal = apiFetch;
  // Sayfa açılışında access token varsa proaktif yenileme zamanla
  try {
    if (getToken() && getRefreshToken()) scheduleProactiveRefresh(null);
  } catch (eBoot) {}
  try {
    globalThis.apiFetch = apiFetch;
  } catch (eG) {}

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
    p.experience = p.experience != null ? (Number(p.experience) > 10 ? 1 + (Math.min(99, Number(p.experience))/99)*9 : Math.max(1, Math.min(10, Number(p.experience)||3))) : 3;
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
    const nextPlayers = (serverTeam.players || []).map((p, i) =>
      normalizeServerPlayer(p, i, true),
    );
    const nextBench = (serverTeam.bench || []).map((p, i) =>
      normalizeServerPlayer(p, i, false),
    );
    // Sunucu boş XI döndürdüyse mevcut client kadroyu silme
    if (nextPlayers.length > 0) {
      teamConfig.home.players = nextPlayers;
      teamConfig.home.bench = nextBench;
    } else if (
      !(teamConfig.home.players && teamConfig.home.players.length)
    ) {
      teamConfig.home.players = nextPlayers;
      teamConfig.home.bench = nextBench;
    } else {
      console.warn(
        "[em] applyServerTeamToClient: empty XI ignored, kept local",
        teamConfig.home.players.length,
      );
    }
    teamConfig.home.gameStyle = serverTeam.gameStyle || teamConfig.home.gameStyle;
    teamConfig.home.passStyle = serverTeam.passStyle || teamConfig.home.passStyle;
    teamConfig.home.attackDir = serverTeam.attackDir || teamConfig.home.attackDir;
    if (serverTeam.customTactics)
      teamConfig.home.customTactics = serverTeam.customTactics;
    if (serverTeam.advancedTactics)
      teamConfig.home.advancedTactics = serverTeam.advancedTactics;
    if (serverTeam.teamBehavior)
      teamConfig.home.teamBehavior = serverTeam.teamBehavior;
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
      isBot: !!r.isBot,
      clubId: r.clubId,
      players: r.userId ? teamConfig.home.players : undefined,
    }));
    worldLeagues[USER_COUNTRY][USER_DIVISION] = mapped;
    try {
      renderStandings();
    } catch (e) {}
  }
  window.__emApplyServerStandings = applyServerStandingsToClient;

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
      if (f.status === "live") {
        btn.innerText = "📡 Canlı İzle";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.onclick = function (e) {
          if (e) e.stopPropagation();
          watchFixture(f.id);
        };
      } else if (f.status === "finished") {
        btn.innerText = "📋 Sonraki maç";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.onclick = function (e) {
          if (e) e.stopPropagation();
          refreshNextMatchFromServer().catch(function () {});
        };
      } else {
        const left = Math.max(0, new Date(f.kickoffAt).getTime() - Date.now());
        const m = Math.floor(left / 60000);
        btn.innerText =
          left <= 0
            ? "▶ İzlemeye Gir"
            : "⏳ " + m + " dk · İzle";
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.onclick = function (e) {
          if (e) e.stopPropagation();
          watchFixture(f.id);
        };
      }
    } else {
      title.innerText = "Fikstür yok";
      meta.innerText =
        "Lig fikstürü yok — kayıt/giriş sonrası otomatik oluşur.";
      btn.innerText = "Lig hazırla";
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.onclick = function (e) {
        if (e) e.stopPropagation();
        ensureLeagueReady().then(function () {
          refreshNextMatchFromServer().catch(function () {});
        });
      };
    }
  }

  async function ensureLeagueReady() {
    try {
      const next = await apiFetch("/api/fixtures/next");
      if (next && next.fixture) return next.fixture;
      await apiFetch("/api/league/fill-bots", {
        method: "POST",
        body: JSON.stringify({
          targetSize: 8,
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
    if (!getToken()) return;
    window.__emServerAuthoritative = true;
    let teamOk = false;
    try {
      const t = await apiFetch("/api/team");
      if (t && t.team) {
        applyServerTeamToClient(t.team);
        teamOk = true;
      }
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
    try {
      const st = document.getElementById("menuSaveStatus");
      if (st && teamOk)
        st.innerText =
          "Sunucu senkron · " +
          new Date().toLocaleTimeString("tr-TR", {
            hour: "2-digit",
            minute: "2-digit",
          });
    } catch (eUi) {}
    console.log("[em] syncAllFromServer done, teamOk=", teamOk);
    try {
      const badge = document.getElementById("emOnlineBadge");
      if (badge) {
        badge.style.display = "inline-block";
        badge.innerText = teamOk ? "🟢 Online" : "🟡 Kısmi";
        badge.style.color = teamOk ? "#4ade80" : "#facc15";
      }
      const st = document.getElementById("menuSaveStatus");
      if (st && teamOk)
        st.innerText =
          "Sunucu senkron · " +
          new Date().toLocaleTimeString("tr-TR", {
            hour: "2-digit",
            minute: "2-digit",
          });
    } catch (eB) {}
  }
  window.syncAllFromServer = syncAllFromServer;

  /**
   * Sayfa açılınca ilgili veriyi sunucudan çek — yerel kalıntı ezmesin.
   * pageId: page-training | page-youth | page-stadium | page-tactics |
   *         page-squad | page-leagues | page-club | ...
   */
  async function ensureServerAuthorityOnPage(pageId) {
    if (!getToken() || !window.__emServerAuthoritative) return;
    const id = String(pageId || "");
    try {
      if (
        id.indexOf("training") >= 0 ||
        id.indexOf("tactics") >= 0 ||
        id.indexOf("squad") >= 0 ||
        id.indexOf("formation") >= 0 ||
        id.indexOf("club") >= 0 ||
        id === "page-match"
      ) {
        try {
          const team = await apiFetch("/api/team");
          if (team && team.team) applyServerTeamToClient(team.team);
        } catch (e) {}
        try {
          const eco = await apiFetch("/api/economy");
          applyServerEconomyToClient(eco);
        } catch (e) {}
      }
      if (id.indexOf("training") >= 0) {
        try {
          await fetchTrainingFromServer();
        } catch (e) {}
      }
      if (id.indexOf("youth") >= 0 || id.indexOf("academy") >= 0) {
        try {
          if (typeof fetchYouthFromServer === "function")
            await fetchYouthFromServer();
          else {
            const y = await apiFetch("/api/youth");
            if (y && y.state && typeof applyYouthStateToClient === "function")
              applyYouthStateToClient(y.state);
          }
        } catch (e) {}
      }
      if (id.indexOf("stadium") >= 0) {
        try {
          await fetchStadiumFromServer();
        } catch (e) {}
      }
      if (id.indexOf("league") >= 0 || id.indexOf("live") >= 0) {
        try {
          const st = await apiFetch("/api/league/standings");
          if (st && typeof applyServerStandingsToClient === "function")
            applyServerStandingsToClient(st.standings || []);
        } catch (e) {}
        try {
          await refreshNextMatchFromServer();
        } catch (e) {}
      }
      if (id.indexOf("transfer") >= 0 || id.indexOf("market") >= 0) {
        try {
          if (typeof fetchTransfersFromServer === "function")
            await fetchTransfersFromServer();
        } catch (e) {}
      }
    } catch (e) {
      console.warn("[em] page authority", id, e);
    }
  }
  window.ensureServerAuthorityOnPage = ensureServerAuthorityOnPage;



  // ------------------------------------------------------------
  // Socket.io — canlı maç izleme
  // ------------------------------------------------------------
  /** Milli maç mı? (nm_ id veya cache) */
  function isNationalFixtureId(fixtureId) {
    const s = String(fixtureId || "");
    if (!s) return false;
    if (s.indexOf("nm_") === 0) return true;
    if (/national/i.test(s)) return true;
    try {
      const f =
        (typeof _emFixtureCache !== "undefined" &&
          _emFixtureCache &&
          _emFixtureCache[s]) ||
        null;
      if (
        f &&
        (f.competition === "national" ||
          f.kind === "national" ||
          f.isNational ||
          f.category === "A" ||
          f.category === "U21")
      )
        return true;
    } catch (e) {}
    return false;
  }

  /** 2D saha: Elite VEYA milli maç VEYA kendi maçın (katılımcı) */
  function canViewMatch2D(fixtureId) {
    try {
      if (typeof isEliteMember === "function" && isEliteMember()) return true;
    } catch (e) {}
    const fid = fixtureId || window._emWatchingFixtureId;
    if (isNationalFixtureId(fid)) return true;
    // Kendi maçını oynarken / izlerken saha görünsün
    try {
      if (_emMySide === "home" || _emMySide === "away") return true;
    } catch (e2) {}
    try {
      if (typeof determineMySide === "function" && fid) {
        const side = determineMySide(fid);
        if (side === "home" || side === "away") return true;
      }
    } catch (e3) {}
    return false;
  }

  function setMatch2DVisible(show) {
    try {
      const pageEl = document.getElementById("page-match");
      if (pageEl && !pageEl.classList.contains("active")) {
        try {
          document.querySelectorAll(".page.active").forEach(function (el) {
            el.classList.remove("active");
          });
        } catch (eA) {}
        pageEl.classList.add("active");
      }
      const fw =
        document.querySelector("#page-match .field-wrapper") ||
        document.querySelector(".field-wrapper");
      const note = document.getElementById("freeMatchTextNote");
      if (show) {
        if (typeof ensureMatchFieldVisible === "function")
          ensureMatchFieldVisible();
        else if (fw) {
          fw.style.display = "block";
          fw.style.visibility = "visible";
          fw.style.minHeight = "220px";
        }
        if (note) note.style.display = "none";
      } else {
        if (fw) {
          fw.style.display = "none";
        }
        if (note) {
          note.style.display = "block";
          note.innerHTML =
            '<div style="padding:14px;background:#0f172a;border:1px solid #facc15;border-radius:12px;text-align:center;color:#fde68a;font-size:13px;line-height:1.5;">' +
            "📝 Bu maç metin rapor olarak izleniyor.<br/>" +
            "<b>2D saha yalnızca Elite üyeler</b> için açılır.<br/>" +
            "<span style=\"color:#94a3b8;font-size:12px;\">Milli takım maçları herkese 2D açıktır. Elite için Destek Ol → Elite sayfası.</span>" +
            '<div style="margin-top:10px;"><button type="button" class="sub-btn" style="width:auto;padding:8px 14px;background:linear-gradient(90deg,#f59e0b,#d97706);font-weight:800;" onclick="typeof goToPremium===\'function\'&&goToPremium()">⭐ Elite / Destek Ol</button></div>' +
            "</div>";
        }
        // Beyaz ekran olmasın: skor paneli / prematch görünsün
        try {
          const pre = document.getElementById("prematch-actions");
          if (pre) {
            pre.style.display = "block";
            pre.style.visibility = "visible";
          }
          const rc = document.getElementById("report-container");
          if (rc) {
            rc.style.display = "block";
            rc.style.visibility = "visible";
          }
        } catch (eP) {}
      }
    } catch (e) {
      console.warn("setMatch2DVisible", e);
    }
  }
  window.canViewMatch2D = canViewMatch2D;
  window.isNationalFixtureId = isNationalFixtureId;
  window.setMatch2DVisible = setMatch2DVisible;


  function startEmSyncHeartbeat() {
    try {
      if (_emSyncHeartbeat) clearInterval(_emSyncHeartbeat);
    } catch (e) {}
    _emSyncHeartbeat = setInterval(function () {
      try {
        if (!getToken() || !window.__emServerAuthoritative) return;
        if (document.hidden) return;
        // Hafif senkron: standings + ekonomi + takım push
        syncAllFromServer().catch(function () {});
        if (typeof pushTeamToServer === "function") {
          pushTeamToServer({ allowEmpty: false }).catch(function () {});
        }
        // Presence ping
        apiFetch("/api/instant/presence", {
          method: "POST",
          body: JSON.stringify({}),
        }).catch(function () {});
      } catch (e) {}
    }, 120000); // 2 dk
  }
  function stopEmSyncHeartbeat() {
    try {
      if (_emSyncHeartbeat) clearInterval(_emSyncHeartbeat);
      _emSyncHeartbeat = null;
    } catch (e) {}
  }
  window.startEmSyncHeartbeat = startEmSyncHeartbeat;

  
  function ensureConnBanner() {
    let el = document.getElementById("emConnBanner");
    if (el) return el;
    el = document.createElement("div");
    el.id = "emConnBanner";
    el.style.cssText =
      "display:none;position:fixed;top:0;left:0;right:0;z-index:99999;padding:8px 12px;text-align:center;font-size:13px;font-weight:700;background:#7f1d1d;color:#fecaca;";
    document.body.appendChild(el);
    return el;
  }
  function setConnBanner(show, text) {
    try {
      const el = ensureConnBanner();
      if (!show) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.innerText = text || "Bağlantı koptu — yeniden bağlanılıyor…";
    } catch (e) {}
  }
  window.__emSetConnBanner = setConnBanner;

  // --- Maç içi side / watch kalıcılığı (reconnect) ---
  function persistMatchSide(side, fixtureId) {
    try {
      if (side === "home" || side === "away") {
        _emMySide = side;
        _emMyMatchSide = side;
        window.__emMySide = side;
        window.__emMyMatchSide = side;
        const fid = fixtureId || window._emWatchingFixtureId;
        if (fid && typeof sessionStorage !== "undefined") {
          sessionStorage.setItem("em_match_side_" + fid, side);
        }
      }
    } catch (e) {}
  }
  function restoreMatchSide(fixtureId) {
    try {
      const fid = fixtureId || window._emWatchingFixtureId;
      if (!fid) return null;
      if (_emMySide === "home" || _emMySide === "away") return _emMySide;
      if (typeof sessionStorage !== "undefined") {
        const s = sessionStorage.getItem("em_match_side_" + fid);
        if (s === "home" || s === "away") {
          _emMySide = s;
          _emMyMatchSide = s;
          window.__emMySide = s;
          window.__emMyMatchSide = s;
          return s;
        }
      }
    } catch (e) {}
    return null;
  }
  function clearPersistedMatchSide(fixtureId) {
    try {
      const fid = fixtureId || window._emWatchingFixtureId;
      if (fid && typeof sessionStorage !== "undefined") {
        sessionStorage.removeItem("em_match_side_" + fid);
      }
    } catch (e) {}
  }
  function rewatchLiveMatch(reason) {
    try {
      if (!socket || !socket.connected) return false;
      const fid = window._emWatchingFixtureId;
      const mid = window._emWatchingMatchId;
      if (!fid && !mid) return false;
      // Side'ı hemen restore et (your-side gelene kadar panel kilitlenmesin)
      if (fid) restoreMatchSide(fid);
      const payload = {};
      if (fid) payload.fixtureId = fid;
      if (mid) payload.matchId = mid;
      socket.emit("fixture:watch", payload);
      if (reason === "reconnect") {
        setConnBanner(true, "🔄 Maç senkronize ediliyor…");
        // State gelince banner kapanır (match:state handler); yedek timeout
        if (window._emSyncBannerTimer) clearTimeout(window._emSyncBannerTimer);
        window._emSyncBannerTimer = setTimeout(function () {
          try {
            if (socket && socket.connected) setConnBanner(false);
          } catch (e) {}
        }, 4000);
        if (typeof addLog === "function") {
          addLog("🔄 Bağlantı yenilendi — maç odasına yeniden katıldın.", "tactics-log");
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function connectSocket() {
    if (typeof io === "undefined") {
      console.warn("[em] socket.io client yüklenmedi");
      return;
    }
    if (socket) socket.disconnect();
    const token = typeof getToken === "function" ? getToken() : null;
    socket = io(API_BASE, {
      auth: { token: token },
      // Maç içi kopma sonrası hızlı ve agresif yeniden bağlanma
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.3,
      timeout: 12000,
    });

    socket.on("connect", () => {
      // Auth token güncel mi? (uzun maçta JWT expire riski)
      try {
        const t = typeof getToken === "function" ? getToken() : null;
        if (t && socket && socket.auth) socket.auth.token = t;
      } catch (eTok) {}
      try {
        const b = document.getElementById("emOnlineBadge");
        if (b) {
          b.style.display = "inline-block";
          b.innerText = "🟢 Online";
          b.style.color = "#4ade80";
        }
      } catch (eB) {}
      try {
        startEmSyncHeartbeat();
      } catch (e) {}
      // Maç içi reconnect: izlenen fikstür/matchId varsa odaya hemen abone ol
      const wasWatching =
        !!(window._emWatchingFixtureId || window._emWatchingMatchId);
      if (wasWatching) {
        rewatchLiveMatch("reconnect");
      } else {
        setConnBanner(false);
      }
    });
    socket.on("disconnect", (reason) => {
      setConnBanner(true, "Bağlantı koptu (" + (reason || "?") + ") — yeniden deneniyor…");
      try {
        const b = document.getElementById("emOnlineBadge");
        if (b) {
          b.style.display = "inline-block";
          b.innerText = "🔴 Offline";
          b.style.color = "#f87171";
        }
      } catch (eB) {}
    });
    socket.on("session:ended", function (payload) {
      try {
        const code = (payload && payload.code) || "TOKEN_REVOKED";
        const msg =
          (payload && payload.message) ||
          "Oturumunuz sonlandırıldı. Tekrar giriş yapın.";
        if (typeof forceClientLogout === "function") {
          forceClientLogout(code, msg);
        } else if (typeof window.__emForceClientLogout === "function") {
          window.__emForceClientLogout(code, msg);
        }
        try {
          if (socket) socket.disconnect();
        } catch (eD) {}
      } catch (eS) {}
    });
    socket.on("maintenance:status", function (payload) {
      try {
        const on = !!(payload && payload.enabled);
        const msg =
          (payload && payload.message) ||
          "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.";
        if (typeof window.__emSetMaintenance === "function") {
          window.__emSetMaintenance(on, msg);
        }
        if (on) {
          try {
            setConnBanner(true, "🛠️ Bakım: " + String(msg).slice(0, 80));
          } catch (eB) {}
        } else {
          try {
            setConnBanner(false);
          } catch (eB2) {}
        }
      } catch (eM) {}
    });
    socket.on("admin:announce", function (payload) {
      try {
        const msg = (payload && payload.message) || "";
        if (!msg) return;
        const level = (payload && payload.level) || "info";
        const prefix =
          level === "urgent" ? "🚨 " : level === "warn" ? "⚠️ " : "📢 ";
        try {
          setConnBanner(true, prefix + String(msg).slice(0, 100));
          setTimeout(function () {
            try {
              if (!window.__emMaintenance) setConnBanner(false);
            } catch (eT) {}
          }, level === "urgent" ? 20000 : 12000);
        } catch (eB) {}
        try {
          if (typeof alert === "function" && level === "urgent") {
            alert(prefix + msg);
          }
        } catch (eA) {}
      } catch (eAnn) {}
    });
    socket.on("connect_error", (err) => {
      console.warn("[em] socket bağlantı hatası:", err && err.message);
      try {
        const msg = (err && err.message) || "";
        if (/auth|token|jwt|unauthorized/i.test(msg)) {
          setConnBanner(
            true,
            "Oturum süresi dolmuş olabilir — sayfayı yenile veya tekrar giriş yap.",
          );
        }
      } catch (e) {}
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

    socket.on("match:tick", (d) => {
      try {
        if (!d) return;
        if (typeof matchMinute !== "undefined" && d.minute != null) matchMinute = d.minute;
        if (d.score) {
          try {
            if (typeof homeScore !== "undefined") homeScore = d.score.home || 0;
            if (typeof awayScore !== "undefined") awayScore = d.score.away || 0;
          } catch (eSc) {}
          try {
            const sb = document.getElementById("scoreBoard");
            if (sb) {
              const minStr = String(d.minute != null ? d.minute : 0).padStart(2, "0");
              const hn =
                (typeof teamConfig !== "undefined" && teamConfig.home && teamConfig.home.name) ||
                "Ev";
              const an =
                (typeof teamConfig !== "undefined" && teamConfig.away && teamConfig.away.name) ||
                "Dep";
              sb.innerText =
                minStr + ":00 - " + hn + " " + (d.score.home || 0) + " - " +
                (d.score.away || 0) + " " + an;
            }
          } catch (eSb) {}
        }
        try {
          const timer = document.getElementById("matchTimerDisplay");
          if (timer && d.minute != null) timer.innerHTML = "⏱️ " + d.minute + ":00";
        } catch (eT) {}
        if (d.possession) {
          try {
            const hp = Math.round(Number(d.possession.home) || 50);
            const elH = document.getElementById("homePossession");
            const elA = document.getElementById("awayPossession");
            const fill = document.getElementById("possessionFill");
            if (elH) elH.innerText = hp + "%";
            if (elA) elA.innerText = (100 - hp) + "%";
            if (fill) fill.style.width = hp + "%";
          } catch (eP) {}
        }
        if (typeof scheduleRender === "function") scheduleRender();
      } catch (e) {}
    });

    socket.on("match:your-side", (d) => {
      try {
        if (d && (d.side === "home" || d.side === "away")) {
          persistMatchSide(d.side, (d && d.fixtureId) || window._emWatchingFixtureId);
          try {
            if (typeof maybeShowInmatchPanel === "function") {
              /* panel dakika kontrolü state ile */
            }
          } catch (eP) {}
        }
      } catch (e) {}
    });

    socket.on("match:state", (state) => {
      // 2D: Elite veya milli maç; diğerleri metin
      try {
        if (!state) return;
        // Reconnect senkron banner'ını kapat
        try {
          if (window._emSyncBannerTimer) {
            clearTimeout(window._emSyncBannerTimer);
            window._emSyncBannerTimer = null;
          }
          setConnBanner(false);
        } catch (eBan) {}
        // Skor globals
        try {
          if (state.score) {
            if (typeof homeScore !== "undefined") homeScore = state.score.home || 0;
            if (typeof awayScore !== "undefined") awayScore = state.score.away || 0;
          }
          if (state.minute != null && typeof matchMinute !== "undefined")
            matchMinute = state.minute;
        } catch (eSc) {}
        renderServerMatchState(state);
        maybeShowInmatchPanel(state);
        const fid = window._emWatchingFixtureId || (state && state.fixtureId);
        const allow2d = canViewMatch2D(fid);
        setMatch2DVisible(allow2d);
        if (allow2d) {
          applyServerPositions(state);
          if (typeof scheduleRender === "function") scheduleRender();
        } else {
          try {
            renderTextOnlyMatchState(state);
          } catch (eT) {}
        }
        // match:ended kaçarsa bile bitiş UI
        if (state.status === "ended" && window._emServerMatchActive) {
          try {
            const status = document.getElementById("matchStatus");
            if (status) status.innerText = "🏁 Maç bitti";
            const timer = document.getElementById("matchTimerDisplay");
            if (timer) timer.innerHTML = "⏱️ MAÇ BİTTİ";
          } catch (eEnd) {}
        }
      } catch (e) {
        try {
          renderTextOnlyMatchState(state);
        } catch (e2) {}
      }
    });

    socket.on("instant:challenge", (ch) => {
      try {
        if (!ch) return;
        const msg =
          (ch.fromUsername || "Bir menajer") +
          " sana anlık maç teklifi gönderdi. Kabul edilsin mi?";
        if (confirm(msg)) {
          apiFetch("/api/instant/respond", {
            method: "POST",
            body: JSON.stringify({ challengeId: ch.id, accept: true }),
          })
            .then(function (r) {
              if (r && r.fixtureId && typeof window.__emWatchInstantMatch === "function") {
                window.__emWatchInstantMatch(r);
              }
            })
            .catch(function (e) {
              alert(e.message || "Kabul başarısız");
            });
        } else {
          apiFetch("/api/instant/respond", {
            method: "POST",
            body: JSON.stringify({ challengeId: ch.id, accept: false }),
          }).catch(function () {});
        }
        if (typeof pushNotification === "function") {
          pushNotification("⚡", (ch.fromUsername || "Rakip") + " anlık maç teklifi", "Anlık Maç");
        }
      } catch (e) {
        console.warn("[em] instant challenge", e);
      }
    });

    socket.on("instant:challenge-result", (r) => {
      try {
        if (!r) return;
        if (r.accept === false || r.accepted === false) {
          alert("Anlık maç teklifin reddedildi.");
          return;
        }
        if (r.fixtureId && typeof window.__emWatchInstantMatch === "function") {
          window.__emWatchInstantMatch(r);
        }
      } catch (e) {}
    });

    socket.on("instant:match-start", (r) => {
      try {
        if (r && r.fixtureId && typeof window.__emWatchInstantMatch === "function") {
          window.__emWatchInstantMatch(r);
        }
      } catch (e) {}
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
        if (!d) return;
        // 2D kapalıysa (Elite değil / milli değil) top animasyonu yok
        if (!canViewMatch2D(window._emWatchingFixtureId) && !window._emForce2dBall)
          return;
        if (typeof ball === "undefined") return;
        ball.holder = null;
        if (d.x != null) {
          ball.targetX = d.x;
          ball.targetY = d.y != null ? d.y : ball.y;
          // Ani zıplama yerine hedefe yönlendir (lerp ball.update'de)
          if (Math.abs((ball.x || 0) - d.x) > 120) {
            ball.x = d.x;
            ball.y = d.y != null ? d.y : ball.y;
          }
        }
        if (typeof scheduleRender === "function") scheduleRender();
      } catch (e) {}
    });

    socket.on("match:goal", (d) => {
      try {
        if (d && d.score) {
          try {
            if (typeof homeScore !== "undefined") homeScore = d.score.home || 0;
            if (typeof awayScore !== "undefined") awayScore = d.score.away || 0;
          } catch (eSc) {}
          try {
            const sb = document.getElementById("scoreBoard");
            if (sb) {
              const minStr = String(
                d.minute != null
                  ? d.minute
                  : typeof matchMinute !== "undefined"
                    ? matchMinute
                    : 0,
              ).padStart(2, "0");
              const hn =
                (typeof teamConfig !== "undefined" && teamConfig.home && teamConfig.home.name) ||
                "Ev";
              const an =
                (typeof teamConfig !== "undefined" && teamConfig.away && teamConfig.away.name) ||
                "Dep";
              sb.innerText =
                minStr + ":00 - " + hn + " " + (d.score.home || 0) + " - " +
                (d.score.away || 0) + " " + an;
            }
          } catch (eSb) {}
        }
        addLog(
          "⚽ GOL! " +
            (d && d.scorer ? d.scorer : "?") +
            (d && d.assist ? " (Asist: " + d.assist + ")" : ""),
          "goal",
        );
        try {
          if (typeof announceGoal === "function" && d && d.scorer) announceGoal(d.scorer);
        } catch (eA) {}
        if (typeof scheduleRender === "function") scheduleRender();
      } catch (e) {}
    });

    socket.on("match:log", (d) => {
      try {
        addLog(d.minute + "' " + d.text, "tactics-log");
      } catch (e) {}
    });

    socket.on("season:finalized", (payload) => {
      try {
        const champ =
          (payload && payload.champion && payload.champion.name) || "—";
        const yl = (payload && payload.yearLabel) || "Sezon";
        if (typeof pushNotification === "function") {
          pushNotification(
            "🏆",
            yl + " tamamlandı · Şampiyon: " + champ,
            "Lig",
          );
        }
        // Puan durumu / fikstür yenile
        try {
          if (typeof window.refreshStandingsFromServer === "function") {
            window.refreshStandingsFromServer();
          } else if (typeof renderStandings === "function") {
            renderStandings();
          }
        } catch (e1) {}
        try {
          if (typeof window.refreshNextMatchFromServer === "function") {
            window.refreshNextMatchFromServer();
          }
        } catch (e2) {}
      } catch (e) {
        console.warn("[em] season:finalized", e);
      }
    });

    socket.on("match:ended", async (state) => {
      try {
        const hs = (state && state.score && state.score.home) || 0;
        const as = (state && state.score && state.score.away) || 0;
        // Son state'i uygula (skor/istatistik/2D pozisyon)
        try {
          if (state) {
            renderServerMatchState(state);
            if (typeof canViewMatch2D === "function" &&
                canViewMatch2D(window._emWatchingFixtureId || (state && state.fixtureId))) {
              applyServerPositions(state);
              if (typeof setMatch2DVisible === "function") setMatch2DVisible(true);
            }
            if (typeof scheduleRender === "function") scheduleRender();
          }
        } catch (eState) {}
        try {
          if (typeof homeScore !== "undefined") homeScore = hs;
          if (typeof awayScore !== "undefined") awayScore = as;
          if (typeof matchMinute !== "undefined" && state && state.minute != null)
            matchMinute = state.minute;
        } catch (eSc) {}
        try {
          if (typeof ml === "function") {
            addLog(
              ml("match_end", {
                home: "",
                away: "",
                hs: hs,
                as: as,
              }),
              "match-end",
            );
          } else {
            addLog("🏁 Full time: " + hs + " - " + as, "match-end");
          }
        } catch (e0) {
          try { addLog("🏁 " + hs + " - " + as, "match-end"); } catch (e00) {}
        }
        const status = document.getElementById("matchStatus");
        if (status) status.innerText = "🏁 Maç bitti · " + hs + " - " + as;
        const timer = document.getElementById("matchTimerDisplay");
        if (timer) timer.innerHTML = "⏱️ MAÇ BİTTİ";
        // Skor panosu
        try {
          const scoreBoard = document.getElementById("scoreBoard");
          if (scoreBoard) {
            const hn =
              (state && state.players &&
                state.players.home &&
                (state.players.home.teamName || state.players.home.username)) ||
              (typeof teamConfig !== "undefined" && teamConfig.home && teamConfig.home.name) ||
              "Home";
            const an =
              (state && state.players &&
                state.players.away &&
                (state.players.away.teamName || state.players.away.username)) ||
              (typeof teamConfig !== "undefined" && teamConfig.away && teamConfig.away.name) ||
              "Away";
            scoreBoard.innerText =
              "MAÇ BİTTİ - " + hn + " " + hs + " - " + as + " " + an;
          }
        } catch (e1) {}
        // Özet katmanı
        try {
          const ov = document.getElementById("matchSummaryOverlay");
          const msScore = document.getElementById("msScore");
          const msResult = document.getElementById("msResult");
          if (msScore) msScore.innerText = hs + " - " + as;
          if (msResult) {
            if (hs > as) msResult.innerText = "Home win";
            else if (as > hs) msResult.innerText = "Away win";
            else msResult.innerText = "Draw";
          }
          if (ov) ov.classList.add("active");
        } catch (e2) {}
        // Yerel simülasyon + sunucu izleme bayraklarını kapat
        try {
          if (window._emWatchingFixtureId) {
            window.lastPlayedFixtureId = window._emWatchingFixtureId;
            if (typeof lastPlayedFixtureId !== "undefined") {
              lastPlayedFixtureId = window._emWatchingFixtureId;
            }
          }
        } catch (e3) {}
        if (window._emWatchPoll) {
          clearInterval(window._emWatchPoll);
          window._emWatchPoll = null;
        }
        try {
          if (typeof matchInterval !== "undefined" && matchInterval) {
            clearInterval(matchInterval);
            matchInterval = null;
          }
          if (typeof circulationInterval !== "undefined" && circulationInterval) {
            clearInterval(circulationInterval);
            circulationInterval = null;
          }
        } catch (eInt) {}
        try {
          matchEnded = true;
          matchStarted = false;
          matchPaused = false;
          inMajorAction = false;
          window._majorActionSince = 0;
        } catch (eFl) {}
        window._emServerMatchActive = false;
        try {
          clearPersistedMatchSide(window._emWatchingFixtureId);
        } catch (eClr) {}
        window._emWatchingFixtureId = null;
        window._emWatchingMatchId = null;
        _emMySide = null;
        _emMyMatchSide = null;
        try {
          if (typeof unlockPrematchPanels === "function") unlockPrematchPanels();
        } catch (eU) {}
        try {
          if (typeof updateMatchLiveTabsVisibility === "function")
            updateMatchLiveTabsVisibility();
        } catch (eTab) {}
        try {
          if (typeof ensureMatchFieldVisible === "function")
            ensureMatchFieldVisible();
        } catch (eF) {}
      } catch (e) {
        console.warn("[em] match:ended handler", e);
      }
      // Maç sonucu bildirim DEĞİL — sadece senkron
      try {
        await refreshNextMatchFromServer();
      } catch (e) {}
      try {
        await syncAllFromServer();
      } catch (e) {}
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
    function mergeSide(sideKey) {
      if (!state.positions || !Array.isArray(state.positions[sideKey])) return;
      const arr = state.positions[sideKey];
      // Boş diziyle mevcut kadroyu silme — saha oyuncusuz kalmasın
      if (!arr.length) return;
      if (!teamConfig[sideKey]) teamConfig[sideKey] = { players: [], name: sideKey };
      const prev = teamConfig[sideKey].players || [];
      teamConfig[sideKey].players = arr.map(function (sp, i) {
        const existing = prev[i] || {};
        const x =
          sp && sp.x != null
            ? sp.x
            : existing.x != null
              ? existing.x
              : 50 + i * 40;
        const y =
          sp && sp.y != null
            ? sp.y
            : existing.y != null
              ? existing.y
              : 80 + (i % 4) * 70;
        return Object.assign({}, existing, {
          name: (sp && sp.name) || existing.name || ("P" + (i + 1)),
          pos: (sp && sp.pos) || existing.pos || "MC",
          x: x,
          y: y,
          number: existing.number || (sp && sp.number) || i + 1,
        });
      });
      try {
        if (state.players && state.players[sideKey] && state.players[sideKey].teamName) {
          teamConfig[sideKey].name = state.players[sideKey].teamName;
        }
      } catch (e) {}
    }
    try {
      mergeSide("home");
      mergeSide("away");
    } catch (eM) {}
    try {
      if (typeof ensureMatchPitchPositions === "function")
        ensureMatchPitchPositions();
    } catch (ePos) {}
    if (state.ball && typeof ball !== "undefined") {
      try {
        ball.holder = null;
        if (state.ball.x != null) {
          ball.x = state.ball.x;
          ball.targetX = state.ball.x;
        }
        if (state.ball.y != null) {
          ball.y = state.ball.y;
          ball.targetY = state.ball.y;
        }
      } catch (eB) {}
    }
  }

  
  function renderTextOnlyMatchState(state) {
    if (!state) return;
    try {
      const status = document.getElementById("matchStatus");
      const hs = (state.score && state.score.home) || 0;
      const as = (state.score && state.score.away) || 0;
      const min = state.minute != null ? state.minute : "?";
      if (status) {
        status.innerText =
          "📝 " + min + "' · " + hs + " - " + as + " (metin · Elite=2D)";
      }
      const homeScoreEl = document.getElementById("homeScore");
      const awayScoreEl = document.getElementById("awayScore");
      if (homeScoreEl) homeScoreEl.innerText = String(hs);
      if (awayScoreEl) awayScoreEl.innerText = String(as);
      const timer = document.getElementById("matchTimerDisplay");
      if (timer) timer.innerText = min + "'";
      // Metin modunda saha kapalı (milli değilse)
      if (!canViewMatch2D(window._emWatchingFixtureId)) {
        setMatch2DVisible(false);
      }
    } catch (e) {}
  }

function renderServerMatchState(state) {
    if (!state || !state.score) return;
    const minStr = String(state.minute != null ? state.minute : 0).padStart(2, "0");
    const homeName =
      (state.players && state.players.home && state.players.home.teamName) ||
      (teamConfig.home && teamConfig.home.name) ||
      "Ev";
    const awayName =
      (state.players && state.players.away && state.players.away.teamName) ||
      "Rakip";
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    };
    const sb = document.getElementById("scoreBoard");
    if (sb)
      sb.innerText =
        minStr +
        ":00 - " +
        homeName +
        " " +
        state.score.home +
        " - " +
        state.score.away +
        " " +
        awayName;
    const stHome = (state.stats && state.stats.home) || {};
    const stAway = (state.stats && state.stats.away) || {};
    set("homeShots", stHome.shots != null ? stHome.shots : "0");
    set("awayShots", stAway.shots != null ? stAway.shots : "0");
    set("homeOnTarget", stHome.onTarget != null ? stHome.onTarget : "0");
    set("awayOnTarget", stAway.onTarget != null ? stAway.onTarget : "0");
    set("homeGoals", stHome.goals != null ? stHome.goals : state.score.home);
    set("awayGoals", stAway.goals != null ? stAway.goals : state.score.away);
    // possession sunucuda state.possession = {home,away}; stats içinde değil
    let hp = 50, ap = 50;
    if (state.possession && (state.possession.home != null || state.possession.away != null)) {
      hp = Math.round(Number(state.possession.home) || 50);
      ap = Math.round(Number(state.possession.away) != null ? state.possession.away : 100 - hp);
    } else {
      const ht = Number(stHome.possessionTicks) || 0;
      const at = Number(stAway.possessionTicks) || 0;
      const tot = ht + at;
      if (tot > 0) {
        hp = Math.round((ht / tot) * 100);
        ap = 100 - hp;
      }
    }
    set("homePossession", hp + "%");
    set("awayPossession", ap + "%");
    const fill = document.getElementById("possessionFill");
    if (fill) fill.style.width = hp + "%";
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
    try {
      hideMainMenuAndShowBack();
      switchPage("page-match");
      resetMatchEngineState();
    } catch (e) {}
    // Prematch: home kadro dolu olsun; away boşsa isimli placeholder XI
    try {
      if (typeof teamConfig !== "undefined") {
        if (
          !teamConfig.home.players ||
          teamConfig.home.players.length < 11
        ) {
          // Sunucudan gelmemişse en azından mevcut listeyi koru
          if (!teamConfig.home.players) teamConfig.home.players = [];
        }
        const f = _emFixtureCache[fixtureId];
        if (f) {
          const myId =
            _emMyClub && _emMyClub.id != null ? String(_emMyClub.id) : null;
          let awayName = f.awayName;
          let homeName = f.homeName;
          if (myId && String(f.homeClubId) === myId) {
            awayName = f.awayName;
          } else if (myId && String(f.awayClubId) === myId) {
            awayName = f.homeName;
          }
          if (
            (!teamConfig.away.players || !teamConfig.away.players.length) &&
            typeof generatePlayersForTeam === "function"
          ) {
            const an = awayName || teamConfig.away.name || "Rakip";
            teamConfig.away.name = an;
            const country =
              typeof USER_COUNTRY !== "undefined" ? USER_COUNTRY : "Türkiye";
            teamConfig.away.players = generatePlayersForTeam(
              { name: an },
              country,
              11,
              false,
            );
            teamConfig.away.bench = [];
          } else if (awayName) {
            teamConfig.away.name = awayName;
          }
          if (homeName && myId && String(f.awayClubId) === myId) {
            // Kullanıcı deplasmanda: isimler skorboard için
            if (teamConfig.home && !teamConfig.home.name)
              teamConfig.home.name = homeName;
          }
        }
        if (typeof ensureMatchPitchPositions === "function")
          ensureMatchPitchPositions();
        if (typeof scheduleRender === "function") scheduleRender();
      }
    } catch (ePrematch) {}
    // Yerel simülasyonu tamamen durdur — sunucu otoriter
    try {
      if (typeof matchInterval !== "undefined" && matchInterval) {
        clearInterval(matchInterval);
        matchInterval = null;
      }
      if (typeof circulationInterval !== "undefined" && circulationInterval) {
        clearInterval(circulationInterval);
        circulationInterval = null;
      }
    } catch (eI) {}
    window._emWatchingFixtureId = fixtureId;
    window._emServerMatchActive = true;
    // Önceki maçtan kalan matchId'yi temizle (lig/kupa izleme)
    try {
      if (window._emWatchingMatchId && String(window._emWatchingMatchId).indexOf(String(fixtureId)) < 0) {
        window._emWatchingMatchId = null;
      }
    } catch (eM) {}
    restoreMatchSide(fixtureId);
    if (!socket) connectSocket();
    try {
      matchStarted = true; // UI: canlı maç
      matchEnded = false;
      matchPaused = false;
      inMajorAction = false;
      window._majorActionSince = 0;
      matchWallStartMs = 0; // catchUp yerel tick çalıştırmasın
    } catch (eFl) {}
    _emInmatchPanelShown = false;
    _emMySide = determineMySide(fixtureId);
    // 2D: Elite / milli / kendi maçı — taraf belirlendikten sonra
    try {
      const allow2d = canViewMatch2D(fixtureId);
      setMatch2DVisible(allow2d);
      if (allow2d && typeof scheduleRender === "function") scheduleRender();
      try {
        if (typeof showMatchSubTab === "function") showMatchSubTab("pitch");
      } catch (eP) {}
    } catch (eF) {}
    const status0 = document.getElementById("matchStatus");
    if (status0) status0.innerText = "⏳ Sunucuya bağlanılıyor...";
    // Ücretsiz Render planında sunucu ~15 dk hareketsizlikten sonra uyur;
    // ilk istek onu uyandırırken 30-60 sn sürebilir. Kullanıcı ekranın
    // donduğunu düşünmesin diye birkaç saniye sonra bunu açıkça belirt.
    if (window._emWakeupHintTimer) clearTimeout(window._emWakeupHintTimer);
    window._emWakeupHintTimer = setTimeout(function () {
      const st = document.getElementById("matchStatus");
      if (st && /bağlanılıyor|bekleniyor/i.test(st.innerText || "")) {
        st.innerText =
          "⏳ Sunucu uyandırılıyor (ücretsiz planda ilk istek yavaş olabilir)...";
      }
    }, 4000);
    if (_emMySide == null) {
      // Fikstür önbellekte yoksa (ör. doğrudan link/eski liste) bir kere çek
      apiFetch("/api/fixtures")
        .then((data) => {
          (data.fixtures || []).forEach(cacheFixture);
          _emMySide = determineMySide(fixtureId);
          try {
            const allow2d = canViewMatch2D(fixtureId);
            setMatch2DVisible(allow2d);
            if (allow2d && typeof scheduleRender === "function") scheduleRender();
          } catch (e2) {}
        })
        .catch(() => {});
    }
    const startBtn = document.getElementById("startMatchBtn");
    if (startBtn) startBtn.style.display = "none";
    const status = document.getElementById("matchStatus");
    if (status) status.innerText = "⏳ Maç saati bekleniyor...";
    if (socket && socket.connected) {
      rewatchLiveMatch("watch");
    } else if (socket) {
      socket.emit("fixture:watch", { fixtureId: fixtureId });
    }
    window._emWatchingFixtureId = fixtureId;

    // Saat gelene kadar yeniden abone + geri sayım (1 sn)
    if (window._emWatchPoll) clearInterval(window._emWatchPoll);
    window._emWatchPoll = setInterval(function () {
      if (!socket || !socket.connected) return;
      if (!window._emWatchingFixtureId && !window._emWatchingMatchId) return;
      rewatchLiveMatch("poll");
    }, 3000);
    // Geri sayım metni
    if (window._emCountdownTimer) clearInterval(window._emCountdownTimer);
    window._emCountdownTimer = setInterval(function () {
      try {
        if (!window._emWatchingFixtureId) return;
        const f =
          (_emFixtureCache && _emFixtureCache[window._emWatchingFixtureId]) ||
          _emNextFixture;
        if (!f || f.status === "live" || f.status === "finished") return;
        const status = document.getElementById("matchStatus");
        if (!status || !f.kickoffAt) return;
        const left = Math.max(0, new Date(f.kickoffAt).getTime() - Date.now());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        status.innerText =
          "⏳ " + m + ":" + String(s).padStart(2, "0") + " · kick-off";
      } catch (e) {}
    }, 1000);
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
    if (_emNextFixture) {
      watchFixture(_emNextFixture.id);
    } else {
      // Fikstür henüz önbellekte yok: kullanıcı sunucudan yanıt gelene
      // kadar hiçbir şey olmuyormuş gibi görmesin diye anında geri bildirim
      // ver (özellikle ücretsiz sunucu uyanma gecikmesinde önemli).
      try {
        if (typeof pushNotification === "function") {
          pushNotification("⏳", "Sıradaki maç sunucudan alınıyor...", "Sistem");
        }
      } catch (e) {}
      refreshNextMatchFromServer()
        .then(function () {
          if (_emNextFixture) watchFixture(_emNextFixture.id);
        })
        .catch(() => {});
    }
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
            escapeHtml(f.homeName) +
            " vs " +
            escapeHtml(f.awayName) +
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
  window.goToQuickMatch = function () {
    try {
      hideMainMenuAndShowBack();
      switchPage("page-quick-match");
    } catch (e) {}
    try {
      if (typeof refreshInstantOpponents === "function") refreshInstantOpponents();
    } catch (e2) {}
    try {
      if (typeof loadInstantRankingPanel === "function") loadInstantRankingPanel();
    } catch (e3) {}
    try {
      if (typeof startInstantLobbyRefresh === "function") startInstantLobbyRefresh();
    } catch (e4) {}
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
    // Ülke kupası yoksa otomatik üret (kulüp ülkesi)
    try {
      await apiFetch("/api/cup/generate", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.warn("[em] cup generate", e);
    }
    const data = await apiFetch("/api/cup/bracket");
    _cupBracketCache = data;
    return data;
  }

  function cupTeamLink(name) {
    const n = name || "—";
    // Onclick attribute'una gömülen JS string literali için ayrı kaçış,
    // görünen HTML içeriği için ayrı kaçış gerekir — ikisi karıştırılmamalı.
    // NOT: escapeHtml JS string bağlamında kullanılmamalı (&#39; JS'i bozar).
    const jsSafe = String(n)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "")
      .replace(/\n/g, " ");
    return (
      '<span class="clickable-team" style="cursor:pointer;color:#e2e8f0;text-decoration:underline;" onclick="event.stopPropagation();typeof openClubProfileByName===\'function\'&&openClubProfileByName(\'' +
      jsSafe +
      "')\">" +
      escapeHtml(n) +
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
          escapeHtml(nm) +
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
      // Oyuncu gol/asist: /api/cup/stats ; yedek olarak takım golleri (bracket)
      let goalKing = [];
      let assistKing = [];
      try {
        const stats = await apiFetch("/api/cup/stats?limit=15");
        goalKing = (stats && stats.goalKing) || [];
        assistKing = (stats && stats.assistKing) || [];
      } catch (_) {}

      let html = '<div class="youth-section-title">👑 Kupa Gol / Asist Krallığı</div>';

      if (goalKing.length) {
        html +=
          '<div style="font-size:11px;color:#94a3b8;margin:8px 0 4px;">Gol krallığı (oyuncu)</div>';
        goalKing.forEach((r, i) => {
          html +=
            '<div style="display:flex;justify-content:space-between;padding:8px 10px;margin-bottom:4px;background:#0f172a;border:1px solid #2c3a52;border-radius:8px;font-size:13px;color:#e2e8f0;">' +
            "<span><b style=\"color:#38bdf8;\">" +
            (i + 1) +
            ".</b> " +
            escapeHtml(r.playerName || r.name || "?") +
            ' <span style="color:#64748b;font-size:11px;">' +
            escapeHtml(r.clubName || "") +
            "</span></span><b style=\"color:#4ade80;\">" +
            escapeHtml(String(r.goals != null ? r.goals : r.g || 0)) +
            " gol</b></div>";
        });
      }

      if (assistKing.length) {
        html +=
          '<div style="font-size:11px;color:#94a3b8;margin:12px 0 4px;">Asist krallığı (oyuncu)</div>';
        assistKing.forEach((r, i) => {
          html +=
            '<div style="display:flex;justify-content:space-between;padding:8px 10px;margin-bottom:4px;background:#0f172a;border:1px solid #2c3a52;border-radius:8px;font-size:13px;color:#e2e8f0;">' +
            "<span><b style=\"color:#a78bfa;\">" +
            (i + 1) +
            ".</b> " +
            escapeHtml(r.playerName || r.name || "?") +
            ' <span style="color:#64748b;font-size:11px;">' +
            escapeHtml(r.clubName || "") +
            "</span></span><b style=\"color:#c4b5fd;\">" +
            escapeHtml(String(r.assists != null ? r.assists : 0)) +
            " asist</b></div>";
        });
      }

      // Oyuncu verisi yoksa takım gol sıralaması (bracket fallback)
      if (!goalKing.length && !assistKing.length) {
        const data = await fetchCupBracket();
        const goals = {};
        (data.bracket || []).forEach((f) => {
          if (f.status !== "finished") return;
          if (f.homeName)
            goals[f.homeName] =
              (goals[f.homeName] || 0) + (Number(f.homeGoals) || 0);
          if (f.awayName)
            goals[f.awayName] =
              (goals[f.awayName] || 0) + (Number(f.awayGoals) || 0);
        });
        const ranked = Object.keys(goals)
          .map((n) => ({ name: n, g: goals[n] }))
          .sort((a, b) => b.g - a.g);
        html +=
          '<div style="font-size:11px;color:#94a3b8;margin:8px 0 4px;">Takım golleri (henüz oyuncu scorer kaydı yok)</div>';
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
              escapeHtml(r.name) +
              "</span><b style=\"color:#4ade80;\">" +
              escapeHtml(r.g) +
              " gol</b></div>";
          });
        }
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
            escapeHtml(f.roundLabel || "Tur") +
            ": " +
            escapeHtml(f.homeName || "") +
            " <b style=\"color:#facc15;\">" +
            f.homeGoals +
            "-" +
            f.awayGoals +
            "</b> " +
            escapeHtml(f.awayName || "") +
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
  // Sunucu otoriter kariyer bayrağı
  window.__emServerAuthoritative = false;

  let _pushTeamTimer = null;
  let _pushTeamInFlight = false;
  let _pushTeamQueued = false;

  async function pushTeamToServer(opts) {
    opts = opts || {};
    if (!getToken()) return { ok: false, reason: "no_token" };
    if (typeof teamConfig === "undefined" || !teamConfig.home) {
      return { ok: false, reason: "no_team" };
    }
    const pc =
      (teamConfig.home.players && teamConfig.home.players.length) || 0;
    if (pc < 8 && !opts.allowEmpty) {
      console.warn("[em] pushTeam: kadro çok küçük, atlandı", pc);
      return { ok: false, reason: "empty_squad" };
    }
    if (_pushTeamInFlight) {
      _pushTeamQueued = true;
      return { ok: false, reason: "queued" };
    }
    _pushTeamInFlight = true;
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
            formation:
              teamConfig.home.currentFormation ||
              teamConfig.home.formation ||
              "4-4-2",
            currentFormation:
              teamConfig.home.currentFormation ||
              teamConfig.home.formation ||
              "4-4-2",
            customTactics: teamConfig.home.customTactics || {},
            advancedTactics: teamConfig.home.advancedTactics || {},
            teamBehavior: teamConfig.home.teamBehavior || null,
          },
        }),
      });
      try {
        const st = document.getElementById("menuSaveStatus");
        if (st)
          st.innerText =
            "Sunucu: " +
            new Date().toLocaleTimeString("tr-TR", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
      } catch (eUi) {}
      return { ok: true };
    } catch (e) {
      console.warn("[em] takım sunucuya kaydedilemedi:", e.message || e);
      return { ok: false, reason: e.message || "error" };
    } finally {
      _pushTeamInFlight = false;
      if (_pushTeamQueued) {
        _pushTeamQueued = false;
        schedulePushTeamToServer(50);
      }
    }
  }

  function schedulePushTeamToServer(delayMs) {
    if (_pushTeamTimer) clearTimeout(_pushTeamTimer);
    _pushTeamTimer = setTimeout(function () {
      _pushTeamTimer = null;
      pushTeamToServer().catch(function () {});
    }, delayMs == null ? 800 : delayMs);
  }

  window.pushTeamToServer = pushTeamToServer;
  window.schedulePushTeamToServer = schedulePushTeamToServer;

  const _origSaveCareer = window.saveCareer;
  window.saveCareer = function (showNote, force) {
    // Yerel yedek (çevrimdışı) — asıl kaynak sunucu
    const r = _origSaveCareer ? _origSaveCareer(showNote, force) : true;
    if (getToken() && window.__emServerAuthoritative) {
      if (force || showNote) {
        pushTeamToServer({ allowEmpty: false }).then(function (res) {
          if (showNote && res && res.ok) {
            try {
              if (typeof pushNotification === "function")
                pushNotification("☁️", "Kadro sunucuya kaydedildi", "Sistem");
            } catch (eN) {}
          }
        });
      } else {
        schedulePushTeamToServer(600);
      }
    } else {
      try {
        pushTeamToServer();
      } catch (e) {}
    }
    return r;
  };

  // Taktik / diziliş değişince sunucuya yaz
  (function hookFormationPush() {
    const wrap = function (name) {
      const orig = window[name];
      if (typeof orig !== "function") return;
      window[name] = function () {
        const ret = orig.apply(this, arguments);
        try {
          if (getToken() && window.__emServerAuthoritative)
            schedulePushTeamToServer(500);
        } catch (e) {}
        return ret;
      };
    };
    wrap("afterFormationChange");
    wrap("applyFormationPreset");
  })();

  // loadCareer: JWT varsa index.html zaten kadro/kasa atlıyor; sunucudan çek
  const _origLoadCareer = window.loadCareer;
  window.loadCareer = function (username) {
    const r = _origLoadCareer ? _origLoadCareer(username) : false;
    if (getToken()) {
      window.__emServerAuthoritative = true;
      setTimeout(function () {
        syncAllFromServer().catch(function () {});
      }, 0);
    }
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
    // Sunucu üye numarası (hesap kimliği)
    try {
      const srvNo =
        (data.user && data.user.userNo) ||
        (data.account && data.account.userNo) ||
        null;
      if (srvNo != null) {
        managerNo = Number(srvNo);
        localStorage.setItem(
          "em_user_no_" + String(managerName).toLowerCase(),
          String(managerNo),
        );
      } else if (typeof ensureUserNo === "function") {
        ensureUserNo(managerName);
      }
    } catch (e) {
      try {
        if (typeof ensureUserNo === "function") ensureUserNo(managerName);
      } catch (e2) {}
    }
    const noStr =
      typeof managerNo !== "undefined" &&
      managerNo &&
      typeof formatUserNo === "function"
        ? " · " + formatUserNo(managerNo)
        : "";
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.innerText = v;
    };
    set("usernameDisplay", managerName + noStr);
    set("menuUsername", managerName + noStr);
    set("menuAvatar", managerName.charAt(0).toUpperCase());
    set("mgrProfileUsername", managerName);
    set("mgrProfileAvatar", managerName.charAt(0).toUpperCase());
    try {
      const prev =
        (data && data.previousLastLoginAt) ||
        (data && data.user && data.user.previousLastLoginAt);
      if (prev) {
        const el = document.getElementById("lastLoginInfo");
        if (el)
          el.textContent =
            "Önceki giriş: " + new Date(prev).toLocaleString("tr-TR");
      } else if (typeof window.refreshLastLoginInfo === "function") {
        window.refreshLastLoginInfo();
      }
    } catch (ePrev) {}
    try {
      const uno = document.getElementById("mgrProfileUserNo");
      if (uno)
        uno.innerText =
          typeof managerNo !== "undefined" &&
          managerNo &&
          typeof formatUserNo === "function"
            ? formatUserNo(managerNo)
            : "—";
    } catch (e) {}
    // GÜVENLİK/KARARLILIK: önce ana menüyü göstermeyi dene, sonra giriş
    // ekranını gizle. Eskiden sıra tersti (önce loginOverlay gizleniyor,
    // sonra showMainMenu() çağrılıyordu) ve ikisi TEK bir try/catch
    // içindeydi — showMainMenu() herhangi bir sebeple patlarsa hata
    // sessizce yutuluyor ve kullanıcı hem giriş formu hem ana menü
    // görünmeden, koyu arka plan üstünde boş/"siyah" bir ekranda kalıyordu
    // (özellikle sayfa açılışında tryAutoLogin() ile). Şimdi hata olursa
    // konsola yazılıyor ve giriş ekranı gizlenmiyor, böylece kullanıcı en
    // kötü ihtimalle giriş formunu görmeye devam ediyor.
    try {
      const sm = typeof window.showMainMenu === "function" ? window.showMainMenu : (typeof showMainMenu === "function" ? showMainMenu : null);
      if (!sm) throw new Error("showMainMenu is not defined");
      sm();
      (window.loginOverlay || document.getElementById("loginOverlay")) &&
        (window.loginOverlay || document.getElementById("loginOverlay")).classList.add("hidden");
    } catch (e) {
      console.error("[em] showMainMenu() başarısız, giriş ekranı korunuyor:", e);
      // Kullanıcı konsola bakamıyorsa da hatayı görebilsin diye ekrana da yazıyoruz.
      const errEl = document.getElementById("loginError");
      if (errEl)
        errEl.innerText =
          "Giriş yapıldı ama ana menü açılamadı: " + (e && e.message ? e.message : e);
    }
    _emServerOnline = true;
    window.__emServerAuthoritative = true;
    try {
      updateServerStatusUI();
    } catch (e) {}
    connectSocket();
    try { startEmSyncHeartbeat(); } catch (eH) {}
    // Önce sunucudan çek — yerel kariyer üzerine yazılır (otorite: sunucu)
    await syncAllFromServer();
    // NOT: Girişte pushTeamToServer YOK — eski localStorage kadrosu
    // sunucudaki gerçek kadroyu ezmesin. Kadro değişince schedulePush çalışır.
  }

  async function handleServerLogin() {
    const username = (document.getElementById("loginUsername") || {}).value?.trim();
    const password = (document.getElementById("loginPassword") || {}).value;
    const errorEl = document.getElementById("loginError");
    if (!username || !password) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı ve şifre gerekli.";
      return;
    }
    if (window.__emMaintenance) {
      if (errorEl)
        errorEl.innerText =
          window.__emMaintenanceMsg ||
          "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.";
      return;
    }
    if (errorEl) errorEl.innerText = "Giriş yapılıyor...";
    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      applyAuthTokens(data);
      localStorage.setItem(CLUB_KEY, JSON.stringify(data.club || null));
      if (errorEl) errorEl.innerText = "";
      await afterServerLogin(data);
    } catch (e) {
      let msg = e.message || "Giriş başarısız.";
      if (e && e.code === "MAINTENANCE") {
        msg =
          e.message ||
          "Bakım çalışması sürüyor. Lütfen biraz sonra tekrar dene.";
        try {
          if (typeof window.__emSetMaintenance === "function")
            window.__emSetMaintenance(true, msg);
        } catch (eM) {}
        if (errorEl) errorEl.innerText = msg;
        return;
      }
      if (
        e &&
        (e.code === "BAD_CREDENTIALS" ||
          (e.payload && e.payload.remainingAttempts != null))
      ) {
        const rem =
          (e.payload && e.payload.remainingAttempts != null
            ? e.payload.remainingAttempts
            : null);
        if (rem != null) {
          msg =
            (e.message || "Kullanıcı adı veya şifre hatalı") +
            (String(e.message || "").indexOf("Kalan") >= 0
              ? ""
              : " · Kalan deneme: " + rem);
        }
      }
      if (e && e.code === "ACCOUNT_LOCKED") {
        const ms = Number(e.retryAfterMs || 0);
        const mins = ms > 0 ? Math.max(1, Math.ceil(ms / 60000)) : null;
        msg =
          e.message ||
          "Hesap geçici olarak kilitlendi.";
        if (mins) msg += " Yaklaşık " + mins + " dk sonra tekrar dene.";
        // Geri sayım (opsiyonel UI)
        try {
          if (errorEl && ms > 0) {
            const until = Date.now() + ms;
            if (window._emLoginLockTimer) clearInterval(window._emLoginLockTimer);
            window._emLoginLockTimer = setInterval(function () {
              const left = until - Date.now();
              if (left <= 0) {
                clearInterval(window._emLoginLockTimer);
                window._emLoginLockTimer = null;
                if (errorEl)
                  errorEl.innerText =
                    "Kilit süresi doldu. Tekrar giriş deneyebilirsin.";
                return;
              }
              const s = Math.ceil(left / 1000);
              const m = Math.floor(s / 60);
              const sec = s % 60;
              if (errorEl)
                errorEl.innerText =
                  "Hesap kilitli · kalan " +
                  (m > 0 ? m + " dk " : "") +
                  sec +
                  " sn";
            }, 1000);
          }
        } catch (eT) {}
      } else if (msg.indexOf("doğrulama") >= 0 || msg.indexOf("EMAIL") >= 0) {
        msg +=
          " Aşağıdaki «Doğrulama maili…» ile tekrar gönderebilirsin.";
      }
      if (errorEl && !(e && e.code === "ACCOUNT_LOCKED" && window._emLoginLockTimer))
        errorEl.innerText = msg;
      else if (errorEl && e && e.code === "ACCOUNT_LOCKED" && !window._emLoginLockTimer)
        errorEl.innerText = msg;
    }
  }

  async function handleServerRegister() {
    const username = (document.getElementById("regUsername") || {}).value?.trim();
    const email = (document.getElementById("regEmail") || {}).value?.trim();
    const country =
      (document.getElementById("regCountry") || {}).value || "Türkiye";
    const password = (document.getElementById("regPassword") || {}).value;
    const securityQuestion = (
      document.getElementById("regSecurityQuestion") || {}
    ).value?.trim();
    const securityAnswer = (
      document.getElementById("regSecurityAnswer") || {}
    ).value?.trim();
    const errorEl = document.getElementById("registerError");
    const legalOk = document.getElementById("regLegalAccept");
    if (legalOk && !legalOk.checked) {
      if (errorEl)
        errorEl.innerText =
          "Kayıt için Gizlilik / KVKK ve Kullanım Koşulları'nı kabul etmelisin.";
      return;
    }
    const ageOk = document.getElementById("regAgeAccept");
    if (ageOk && !ageOk.checked) {
      if (errorEl)
        errorEl.innerText =
          "Kayıt için yaş / yasal temsilci onayını işaretlemelisin.";
      return;
    }
    if (!username || username.length < 3) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı en az 3 karakter olmalı.";
      return;
    }
    if (!password || password.length < 8) {
      if (errorEl) errorEl.innerText = "Şifre en az 8 karakter olmalı.";
      return;
    }
    if (!securityQuestion || securityQuestion.length < 5) {
      if (errorEl)
        errorEl.innerText =
          "Güvenlik sorusu zorunlu (şifre unutunca lazım, en az 5 karakter).";
      return;
    }
    if (!securityAnswer || securityAnswer.length < 2) {
      if (errorEl) errorEl.innerText = "Güvenlik sorusu cevabını yaz.";
      return;
    }
    if (errorEl) errorEl.innerText = "Kayıt oluşturuluyor...";
    try {
      const data = await apiFetch("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username,
          password,
          email: email || null,
          teamName: username + " SK",
          country,
          securityQuestion,
          securityAnswer,
          ageAccepted: true,
          legalAccepted: true,
        }),
      });
      applyAuthTokens(data);
      localStorage.setItem(CLUB_KEY, JSON.stringify(data.club || null));
      // Sunucu üye no'sunu kalıcı tut
      try {
        if (data.user && data.user.userNo != null) {
          localStorage.setItem(
            "em_user_no_" + String(username).toLowerCase(),
            String(data.user.userNo),
          );
          if (typeof managerNo !== "undefined") managerNo = data.user.userNo;
        }
      } catch (e) {}
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
        errorEl.innerText = "Tüm alanları doldur (yeni şifre en az 8 karakter).";
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
    setRefreshToken(null);
    try {
      if (_emRefreshTimer) {
        clearTimeout(_emRefreshTimer);
        _emRefreshTimer = null;
      }
    } catch (e) {}
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
        (window.loginOverlay || document.getElementById("loginOverlay")) &&
        (window.loginOverlay || document.getElementById("loginOverlay")).classList.remove("hidden");
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

    // refreshTransferMarket — herkes piyasayı yenileyebilir (AI doldurma admin)
    window.refreshTransferMarket = async function () {
      const note = document.getElementById("transferNote");
      try {
        if (note) note.innerText = "Piyasa yükleniyor...";
        // Önce listeyi çek; gerekirse sunucu refresh (admin değilse AI yok)
        let ok = await fetchTransferMarketFromServer();
        if (
          !ok ||
          (typeof transferMarket !== "undefined" && transferMarket.length < 3)
        ) {
          try {
            await apiFetch("/api/transfer/refresh", {
              method: "POST",
              body: JSON.stringify({}),
            });
            ok = await fetchTransferMarketFromServer();
          } catch (e2) {
            /* admin zorunlu değil */
          }
        }
        if (!ok && typeof ensureTransferMarket === "function") {
          ensureTransferMarket();
        }
        if (typeof renderTransferPage === "function") renderTransferPage();
        if (note)
          note.innerText =
            "Piyasa güncellendi · " +
            ((typeof transferMarket !== "undefined" && transferMarket.length) ||
              0) +
            " ilan";
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
    // Geçerli seviye gelirse uygula; null/0 ile 1'e düşürme
    if (state.scoutLevel != null && Number(state.scoutLevel) >= 1)
      youthAcademy.scoutLevel = Number(state.scoutLevel);
    if (state.academyLevel != null && Number(state.academyLevel) >= 1)
      youthAcademy.academyLevel = Number(state.academyLevel);
    if (state.maxScout != null && Number(state.maxScout) >= 1)
      youthAcademy.maxScout = Number(state.maxScout);
    if (state.maxAcademy != null && Number(state.maxAcademy) >= 1)
      youthAcademy.maxAcademy = Number(state.maxAcademy);
    if (state.drawsThisSeason != null)
      youthAcademy.drawsThisSeason = Number(state.drawsThisSeason) || 0;
    if (state.maxDrawsPerSeason != null)
      youthAcademy.maxDrawsPerSeason = Number(state.maxDrawsPerSeason) || 12;
    youthAcademy.lastDrawWeekKey = state.lastDrawWeekKey || "";
    if (state.scoutUpgradeUntil != null)
      youthAcademy.scoutUpgradeUntil = state.scoutUpgradeUntil || 0;
    if (state.academyUpgradeUntil != null)
      youthAcademy.academyUpgradeUntil = state.academyUpgradeUntil || 0;
    if (state.pendingScoutLevel !== undefined)
      youthAcademy.pendingScoutLevel = state.pendingScoutLevel;
    if (state.pendingAcademyLevel !== undefined)
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
                escapeHtml(r.name || "?") +
                '</span><span class="player-pos">' +
                escapeHtml(r.pos || "") +
                " · " +
                escapeHtml(r.age != null ? r.age : "?") +
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
                escapeHtml(r.name || "?") +
                '</span><span style="color:#86efac;font-size:11px;">' +
                escapeHtml(r.skillLabel || r.skill || "") +
                ": +" +
                escapeHtml(r.delta != null ? r.delta : "?") +
                " → " +
                escapeHtml(r.to != null ? Math.round(r.to) : "") +
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


  // switchPage: sunucu otoritesi
  (function hookSwitchPageAuthority() {
    function install() {
      if (typeof window.switchPage !== "function") return false;
      if (window.switchPage.__emServerHooked) return true;
      const _orig = window.switchPage;
      window.switchPage = function (pageId) {
        const r = _orig.apply(this, arguments);
        try {
          if (getToken() && window.__emServerAuthoritative) {
            ensureServerAuthorityOnPage(pageId).catch(function () {});
          }
        } catch (e) {}
        return r;
      };
      window.switchPage.__emServerHooked = true;
      return true;
    }
    if (!install()) {
      setTimeout(install, 200);
      setTimeout(install, 1000);
      setTimeout(install, 3000);
    }
  })();

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
      if (!getToken() || !window.__emServerAuthoritative) {
        if (note)
          note.innerText =
            "Sunucu bağlantısı yok — antrenman için giriş gerekli.";
        return;
      }
      try {
        if (note) note.innerText = "Sunucuda antrenman uygulanıyor…";
        // Seçili skill: bulk select veya varsayılan stamina
        let skill = "stamina";
        try {
          const bulk =
            document.getElementById("trainingBulkSkill") ||
            document.getElementById("bulkTrainSkillSelect");
          if (bulk && bulk.value) skill = bulk.value;
        } catch (eS) {}
        // İşaretli oyuncular varsa tek tek; yoksa tüm kadro
        const cbs = document.querySelectorAll(
          "#trainingSquadList input[type=checkbox]:checked, .train-player-cb:checked",
        );
        let results = [];
        if (cbs && cbs.length) {
          for (let i = 0; i < cbs.length; i++) {
            const cb = cbs[i];
            const pid =
              cb.dataset.playerId ||
              cb.getAttribute("data-player-id") ||
              cb.value;
            if (!pid) continue;
            // satırdaki skill select
            let sk = skill;
            try {
              const row = cb.closest("div");
              const sel = row && row.querySelector("select");
              if (sel && sel.value) sk = sel.value;
            } catch (eR) {}
            const res = await apiFetch("/api/training/player", {
              method: "POST",
              body: JSON.stringify({ playerId: pid, skill: sk }),
            });
            if (res && res.result) results.push(res.result);
          }
        } else {
          const res = await apiFetch("/api/training/squad", {
            method: "POST",
            body: JSON.stringify({ skill: skill }),
          });
          if (res && Array.isArray(res.results)) results = res.results;
          else if (res && res.result) results = [res.result];
        }
        // Takımı sunucudan tazele
        try {
          const t = await apiFetch("/api/team");
          if (t && t.team) applyServerTeamToClient(t.team);
        } catch (eT) {}
        try {
          await fetchTrainingFromServer();
        } catch (eF) {}
        try {
          if (typeof renderTrainingSquadList === "function")
            renderTrainingSquadList();
        } catch (eL) {}
        if (note) {
          if (results.length) {
            note.innerText =
              results.length +
              " oyuncu antrenman aldı (sunucu). Örn: " +
              (results[0].name || "") +
              " +" +
              (results[0].delta != null ? Number(results[0].delta).toFixed(2) : "?");
          } else {
            note.innerText = "Antrenman tamam (değişiklik yok veya limit).";
          }
        }
        if (typeof pushNotification === "function")
          pushNotification("🏋️", "Antrenman sunucuya işlendi", "Antrenman");
      } catch (e) {
        if (note) note.innerText = e.message || "Antrenman başarısız";
      }
    };
    window.trainWholeSquadSameSkill = window.trainSelectedPlayers;
    window.trainWholeTeamWithCoach = window.trainSelectedPlayers;

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
    window.applyCoachSettings = async function (opts) {
      // Personel sayfası select'leri öncelikli (staffCoach*), yoksa antrenman sayfası
      const skillSel =
        document.getElementById("staffCoachSkillSelect") ||
        document.getElementById("coachSkillSelect");
      const levelSel =
        document.getElementById("staffCoachLevelSelect") ||
        document.getElementById("coachLevelSelect");
      const skill = skillSel ? skillSel.value : "stamina";
      const level = levelSel ? parseInt(levelSel.value, 10) || 1 : 1;
      const note =
        document.getElementById("staffPageNote") ||
        document.getElementById("trainingResultNote");
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
          if (typeof clubCoaches !== "undefined") clubCoaches = res.coaches;
          if (typeof clubCoach !== "undefined" && res.coaches[0])
            clubCoach = res.coaches[0];
        }
        try {
          const eco = await apiFetch("/api/economy");
          if (eco && eco.balance != null && typeof clubBudget !== "undefined") {
            clubBudget = Number(eco.balance);
            if (typeof updateBudgetUI === "function") updateBudgetUI();
          }
        } catch (eEco) {}
        if (note)
          note.innerText =
            "Antrenör kaydedildi: " +
            skill +
            " Sv." +
            level +
            (res.cost ? " · İmza " + res.cost + " €" : "");
        try {
          if (typeof renderTrainingSquadList === "function")
            renderTrainingSquadList();
        } catch (e) {}
        try {
          if (typeof renderClubStaffPage === "function") renderClubStaffPage();
        } catch (e) {}
        return true;
      } catch (e) {
        if (note) note.innerText = e.message || "Antrenör kaydı başarısız";
        // Online otorite: yerel fallback YOK (sunucuyu ezmesin)
        if (!getToken() && _origApplyCoach) {
          try {
            return _origApplyCoach(opts);
          } catch (e2) {}
        }
        return false;
      }
    };
    window.hireSelectedCoach = window.applyCoachSettings;

    window.removeClubCoach = async function (skill) {
      const note =
        document.getElementById("staffPageNote") ||
        document.getElementById("trainingResultNote");
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
          if (typeof clubCoaches !== "undefined") clubCoaches = res.coaches;
          if (typeof clubCoach !== "undefined")
            clubCoach = res.coaches[0] || null;
        }
        if (note) note.innerText = "Antrenör çıkarıldı: " + skill;
        try {
          if (typeof renderClubStaffPage === "function") renderClubStaffPage();
        } catch (e) {}
      } catch (e) {
        if (note) note.innerText = e.message || "Çıkarma başarısız";
        alert(e.message || "Çıkarma başarısız");
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
    window._forumTopicCache = posts || [];
    if (!posts || !posts.length) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:8px;">Henüz konu yok.</div>';
      if (typeof closeForumTopic === "function") closeForumTopic();
      return;
    }
    const me = String(
      (typeof managerName !== "undefined" && managerName) || "",
    ).toLowerCase();
    list.innerHTML = posts
      .map(function (p, idx) {
        const safeUser =
          typeof adminAcEscape === "function"
            ? adminAcEscape(p.user || "?")
            : String(p.user || "?");
        const delId = p.id != null ? p.id : idx;
        const title = String(p.text || "").split("\n")[0].slice(0, 80);
        const safeTitle =
          typeof adminAcEscape === "function"
            ? adminAcEscape(title)
            : title;
        const isAuthor =
          me && String(p.user || "").toLowerCase() === me;
        const showDel = canMod || isAuthor;
        return (
          '<div class="forum-post-card" style="padding:12px;margin-bottom:8px;background:#0f172a;border:1px solid #2c3a52;border-radius:12px;cursor:pointer;" onclick="if(typeof openForumTopic===\'function\')openForumTopic(' +
          JSON.stringify(delId) +
          ')">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px;gap:8px;">' +
          '<b style="color:#38bdf8;">' +
          safeUser +
          '</b><span style="color:#64748b;font-size:11px;flex-shrink:0;">' +
          (p.time || "") +
          (showDel
            ? ' <button type="button" class="sub-btn" style="width:auto;padding:2px 8px;font-size:10px;background:#7f1d1d;cursor:pointer;" onclick="event.preventDefault();event.stopPropagation();if(typeof deleteForumPostAt===\'function\')deleteForumPostAt(' +
              JSON.stringify(delId) +
              ');return false;">Sil</button>'
            : "") +
          "</span></div>" +
          '<div style="color:#e2e8f0;font-size:13px;font-weight:600;">' +
          safeTitle +
          (String(p.text || "").length > 80 ? "…" : "") +
          "</div>" +
          '<div style="color:#64748b;font-size:11px;margin-top:4px;">Konuyu aç →</div></div>'
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

    window.__emDeleteForumPost = async function (idOrIdx) {
      try {
        const id = idOrIdx;
        if (id == null || id === "") return;
        if (typeof apiFetch === "function") {
          const res = await apiFetch("/api/forum/" + encodeURIComponent(String(id)), {
            method: "DELETE",
          });
          if (res && res.ok === false) {
            alert((res && res.error) || "Silinemedi");
            return;
          }
          if (typeof closeForumTopic === "function") closeForumTopic();
          renderForumFromServer((res && res.posts) || []);
          if (!(res && res.posts)) await fetchForumFromServer();
          return;
        }
        if (typeof forumPosts !== "undefined" && forumPosts && forumPosts.splice) {
          forumPosts.splice(Number(idOrIdx), 1);
          if (typeof renderForum === "function") renderForum();
        }
      } catch (e) {
        alert((e && e.message) || "Silinemedi");
      }
    };
    window.deleteForumPostAt = async function (idOrIdx) {
      const me = String(
        (typeof managerName !== "undefined" && managerName) || "",
      ).toLowerCase();
      const cache = window._forumTopicCache || [];
      let post = null;
      for (let i = 0; i < cache.length; i++) {
        if (
          String(cache[i].id) === String(idOrIdx) ||
          String(i) === String(idOrIdx)
        ) {
          post = cache[i];
          break;
        }
      }
      const isAuthor =
        post && me && String(post.user || "").toLowerCase() === me;
      const canMod =
        typeof canModerateForum === "function" && canModerateForum();
      if (!canMod && !isAuthor) {
        alert("Bu konuyu yalnızca yazar veya moderatör silebilir.");
        return;
      }
      if (!confirm("Bu gönderi silinsin mi?")) return;
      return window.__emDeleteForumPost(idOrIdx);
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
              read: !!m.read || m.from === "me",
              fromUserId: m.fromUserId || m.userId || null,
              toUserId: m.toUserId || null,
            });
          });
        }
        if (typeof renderUserMessages === "function") renderUserMessages();
        try {
          if (typeof clearMsgDot === "function") clearMsgDot();
          else {
            const md = document.getElementById("msgDot");
            if (md) md.classList.remove("active");
          }
        } catch (e) {}
        try {
          await apiFetch("/api/messages/read", {
            method: "POST",
            body: JSON.stringify({}),
          });
        } catch (e) {}
      } catch (err) {
        console.warn("[em] messages", err);
      }
      const modal = document.getElementById("messagesModal");
      if (modal) {
        modal.style.zIndex = "100050";
        modal.classList.add("active");
      }
      try {
        if (typeof clearMsgDot === "function") clearMsgDot();
      } catch (e) {}
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

    // Maç sonucu / spam bildirim filtresi
    function isMatchResultNotif(text, category) {
      const low = String(text || "").toLowerCase();
      const catLow = String(category || "").toLowerCase();
      if (
        catLow === "maç" ||
        catLow === "mac" ||
        catLow.indexOf("maç") >= 0 ||
        catLow.indexOf("match") >= 0
      )
        return true;
      if (/\b\d+\s*[-–:]\s*\d+\b/.test(low)) return true;
      if (
        low.indexOf("maç sonucu") >= 0 ||
        low.indexOf("full time") >= 0 ||
        low.indexOf("maç bitti") >= 0 ||
        low.indexOf("yeniden simülasyon") >= 0
      )
        return true;
      if (
        low.indexOf(" vs ") >= 0 &&
        (low.indexOf("kazan") >= 0 ||
          low.indexOf("beraber") >= 0 ||
          low.indexOf("win") >= 0 ||
          low.indexOf("draw") >= 0)
      )
        return true;
      return false;
    }

    // Bildirimler — maç sonucu yazılmaz
    window.pushNotification = function (icon, text, time) {
      if (isMatchResultNotif(text, time)) return;
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
      if (typeof setHeaderBadge === "function") {
        const n = (typeof gameNotifications !== "undefined"
          ? gameNotifications.length
          : 1) || 1;
        setHeaderBadge("notifDot", n);
      } else {
        const dot = document.getElementById("notifDot");
        if (dot) {
          dot.classList.add("active");
          dot.textContent = "1";
        }
      }
    };

    window.openNotifications = async function (e) {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      let notifs = [];
      try {
        const data = await apiFetch("/api/notifications");
        notifs = (data.notifications || []).filter(function (n) {
          return !isMatchResultNotif(n.text, n.category || n.time);
        });
        try {
          await apiFetch("/api/notifications/read", {
            method: "POST",
            body: JSON.stringify({}),
          });
        } catch (e2) {}
      } catch (err) {
        console.warn("[em] notifs", err);
      }
      try {
        if (typeof gameNotifications !== "undefined") {
          gameNotifications.forEach(function (n) {
            if (isMatchResultNotif(n.text, n.time)) return;
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
            '<div style="color:#64748b;text-align:center;padding:8px;">Bildirim yok.<br/><span style="font-size:11px;">Transfer, teklif, skill — maç sonuçları burada yok.</span></div>';
        } else {
          list.innerHTML = notifs
            .map(function (n) {
              const safeText =
                typeof adminAcEscape === "function"
                  ? adminAcEscape(n.text || "")
                  : String(n.text || "");
              return (
                '<div class="team-player-row notif-item" style="background:#1e293b;border:1px solid #475569;border-radius:10px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:flex-start;gap:8px;">' +
                '<span style="font-size:16px;flex-shrink:0;margin-right:4px;">' +
                (n.icon || "🔔") +
                '</span><span class="notif-text" style="flex:1;color:#f8fafc;font-size:13px;line-height:1.45;font-weight:600;">' +
                safeText +
                '</span><span class="notif-time" style="color:#94a3b8;font-size:11px;flex-shrink:0;">' +
                (n.time || "") +
                "</span></div>"
              );
            })
            .join("");
        }
      }
      if (typeof setHeaderBadge === "function") setHeaderBadge("notifDot", 0);
      else {
        const dot = document.getElementById("notifDot");
        if (dot) {
          dot.classList.remove("active");
          dot.textContent = "";
        }
      }
      const modal = document.getElementById("notificationsModal");
      if (modal) {
        modal.style.zIndex = "100050";
        modal.classList.add("active");
      }
    };

    // Okunmamış bildirim + mesaj rozeti poll (30 sn)
    if (!window._emNotifPoll) {
      window._emNotifPoll = setInterval(async function () {
        if (!getToken()) return;
        try {
          const data = await apiFetch("/api/notifications");
          const u = data.unread || 0;
          if (typeof setHeaderBadge === "function") setHeaderBadge("notifDot", u);
          else {
            const dot = document.getElementById("notifDot");
            if (dot) {
              if (u > 0) {
                dot.classList.add("active");
                dot.textContent = u > 99 ? "99+" : String(u);
              } else {
                dot.classList.remove("active");
                dot.textContent = "";
              }
            }
          }
        } catch (e) {}
        try {
          const data = await apiFetch("/api/messages");
          const msgs = (data && data.messages) || [];
          const unread = msgs.filter(function (m) {
            return m.from !== "me" && !m.read;
          }).length;
          if (typeof setHeaderBadge === "function") setHeaderBadge("msgDot", unread);
          else {
            const md = document.getElementById("msgDot");
            if (md) {
              if (unread > 0) {
                md.classList.add("active");
                md.textContent = unread > 99 ? "99+" : String(unread);
              } else {
                md.classList.remove("active");
                md.textContent = "";
              }
            }
          }
          // Yeni mesaj geldiyse mesaj kutusuna kırmızı uyarı için globali güncelle
          if (typeof userMessages !== "undefined" && unread > 0) {
            const prevIds = {};
            userMessages.forEach(function (x) {
              prevIds[(x.from || "") + "|" + (x.text || "") + "|" + (x.time || "")] = true;
            });
            let hasNew = false;
            msgs.forEach(function (m) {
              if (m.from === "me" || m.read) return;
              const k = (m.from || "") + "|" + (m.text || "") + "|" + (m.time || "");
              if (!prevIds[k]) hasNew = true;
            });
            if (hasNew) {
              userMessages.length = 0;
              msgs.forEach(function (m) {
                userMessages.push({
                  from: m.from,
                  to: m.to,
                  text: m.text,
                  time: m.time,
                  read: !!m.read || m.from === "me",
                });
              });
              try {
                if (typeof pushNotification === "function")
                  pushNotification("💬", "Yeni mesajın var", "Mesaj");
              } catch (e2) {}
              const modal = document.getElementById("messagesModal");
              if (modal && modal.classList.contains("active") && typeof renderUserMessages === "function")
                renderUserMessages();
            }
          }
        } catch (e) {}
      }, 30000);
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
      { pos: "DR", x: 130, y: 335 }, { pos: "ML", x: 300, y: 55 },
      { pos: "MC", x: 300, y: 145 }, { pos: "MC", x: 300, y: 255 },
      { pos: "MR", x: 300, y: 330 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 330 },
    ],
    "4-3-3": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "MC", x: 300, y: 100 },
      { pos: "MC", x: 300, y: 200 }, { pos: "MC", x: 300, y: 300 },
      { pos: "FL", x: 490, y: 55 }, { pos: "FC", x: 510, y: 200 },
      { pos: "FR", x: 490, y: 330 },
    ],
    "4-2-3-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "DM", x: 210, y: 140 },
      { pos: "DM", x: 210, y: 260 }, { pos: "ML", x: 380, y: 60 },
      { pos: "OMC", x: 410, y: 200 }, { pos: "MR", x: 380, y: 325 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-5-2": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 40 }, { pos: "MC", x: 300, y: 120 },
      { pos: "DM", x: 220, y: 200 }, { pos: "MC", x: 300, y: 280 },
      { pos: "MR", x: 300, y: 345 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 330 },
    ],
    "5-3-2": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 115, y: 40 },
      { pos: "DC", x: 110, y: 115 }, { pos: "DC", x: 105, y: 200 },
      { pos: "DC", x: 110, y: 285 }, { pos: "DR", x: 115, y: 345 },
      { pos: "MC", x: 300, y: 110 }, { pos: "MC", x: 300, y: 200 },
      { pos: "MC", x: 300, y: 290 }, { pos: "FL", x: 495, y: 55 },
      { pos: "FR", x: 495, y: 330 },
    ],
    "4-1-4-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "DM", x: 210, y: 200 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 140 },
      { pos: "MC", x: 300, y: 260 }, { pos: "MR", x: 300, y: 335 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "4-5-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "ML", x: 300, y: 45 },
      { pos: "MC", x: 300, y: 120 }, { pos: "DM", x: 220, y: 200 },
      { pos: "MC", x: 300, y: 280 }, { pos: "MR", x: 300, y: 340 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-4-3": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 335 },
      { pos: "FL", x: 490, y: 55 }, { pos: "FC", x: 510, y: 200 },
      { pos: "FR", x: 490, y: 330 },
    ],
    "4-3-2-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "MC", x: 300, y: 100 },
      { pos: "MC", x: 300, y: 200 }, { pos: "MC", x: 300, y: 300 },
      { pos: "OMC", x: 410, y: 140 }, { pos: "OMC", x: 410, y: 260 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "3-4-2-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DC", x: 125, y: 95 },
      { pos: "DC", x: 120, y: 200 }, { pos: "DC", x: 125, y: 305 },
      { pos: "ML", x: 300, y: 50 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 335 },
      { pos: "OMC", x: 410, y: 130 }, { pos: "OMC", x: 410, y: 270 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "4-4-1-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 130, y: 50 },
      { pos: "DC", x: 125, y: 140 }, { pos: "DC", x: 125, y: 260 },
      { pos: "DR", x: 130, y: 335 }, { pos: "ML", x: 300, y: 55 },
      { pos: "MC", x: 300, y: 145 }, { pos: "MC", x: 300, y: 255 },
      { pos: "MR", x: 300, y: 330 }, { pos: "OMC", x: 410, y: 200 },
      { pos: "FC", x: 510, y: 200 },
    ],
    "5-4-1": [
      { pos: "GK", x: 50, y: 200 }, { pos: "DL", x: 115, y: 40 },
      { pos: "DC", x: 110, y: 115 }, { pos: "DC", x: 105, y: 200 },
      { pos: "DC", x: 110, y: 285 }, { pos: "DR", x: 115, y: 345 },
      { pos: "ML", x: 300, y: 60 }, { pos: "MC", x: 300, y: 145 },
      { pos: "MC", x: 300, y: 255 }, { pos: "MR", x: 300, y: 325 },
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


  function natSkillKeys() {
    return (
      window.TACTICS_SKILL_KEYS || [
        "agility",
        "reflex",
        "handling",
        "positioning",
        "tackle",
        "strength",
        "pace",
        "stamina",
        "passing",
        "vision",
        "technique",
        "finishing",
      ]
    );
  }
  // Sıralama: key = overall|quality|age|pos|name|club|skillKey · dir 1/-1 · list pool|squad
  let _natSort = { key: "overall", dir: -1, list: "pool" };
  let _natScrollPreserve = null; // seç/çıkar sonrası kaydırma konumu
  window.sortNatPlayerList = function (key, list) {
    list = list === "squad" ? "squad" : "pool";
    if (_natSort.key === key && _natSort.list === list) _natSort.dir = -_natSort.dir;
    else {
      _natSort.key = key;
      _natSort.dir = key === "name" || key === "pos" || key === "club" ? 1 : -1;
      _natSort.list = list;
    }
    try {
      _natScrollPreserve = _captureNatScroll();
      renderNationalManage();
      _restoreNatScroll();
    } catch (e) {}
  };
  function natSortMark(key, list) {
    if (_natSort.list !== list || _natSort.key !== key) return "";
    return _natSort.dir < 0 ? " ↓" : " ↑";
  }
  function natSortPlayers(arr, list) {
    const dir = _natSort.list === list ? _natSort.dir : -1;
    const key = _natSort.list === list ? _natSort.key : "overall";
    return (arr || []).slice().sort(function (a, b) {
      let av, bv;
      if (key === "name") {
        av = String(a.name || "").toLowerCase();
        bv = String(b.name || "").toLowerCase();
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      if (key === "pos") {
        av = String(a.naturalPos || a.pos || "").toUpperCase();
        bv = String(b.naturalPos || b.pos || "").toUpperCase();
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      if (key === "club") {
        av = String(a.clubName || "").toLowerCase();
        bv = String(b.clubName || "").toLowerCase();
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      if (key === "age") {
        av = Number(a.age) || 0;
        bv = Number(b.age) || 0;
        return (av - bv) * dir;
      }
      if (key === "overall" || key === "quality") {
        av = Number(a.overall) || 0;
        bv = Number(b.overall) || 0;
        return (av - bv) * dir;
      }
      av = Math.round(Number(a[key]) || Number(a.skills && a.skills[key]) || 0);
      bv = Math.round(Number(b[key]) || Number(b.skills && b.skills[key]) || 0);
      return (av - bv) * dir;
    });
  }
  function _captureNatScroll() {
    const el = document.getElementById("tacticsNatBody");
    if (!el) return null;
    return {
      bodyTop: el.scrollTop,
      winY: window.scrollY || window.pageYOffset || 0,
    };
  }
  function _restoreNatScroll() {
    const s = _natScrollPreserve;
    _natScrollPreserve = null;
    if (!s) return;
    requestAnimationFrame(function () {
      const el = document.getElementById("tacticsNatBody");
      if (el) el.scrollTop = s.bodyTop;
      window.scrollTo(0, s.winY);
    });
  }
  /** Başlık: Oyuncu | Kalite | Takım | Yaş | skills | İşlem */
  function natSkillHeaderHtml(listKind) {
    const list = listKind === "squad" ? "squad" : "pool";
    const keys = natSkillKeys();
    return (
      '<div class="tactics-skill-header nat-grid-row">' +
      '<span class="tsh-name" style="cursor:pointer;" onclick="sortNatPlayerList(\'name\',\'' +
      list +
      "')\">Oyuncu" +
      natSortMark("name", list) +
      '</span><span class="tsh-quality" style="cursor:pointer;" title="Kalite / overall" onclick="sortNatPlayerList(\'quality\',\'' +
      list +
      "')\">Kalite" +
      natSortMark("quality", list) +
      '</span><span class="tsh-team" style="cursor:pointer;" onclick="sortNatPlayerList(\'club\',\'' +
      list +
      "')\">Takım" +
      natSortMark("club", list) +
      '</span><span class="tsh-age" style="cursor:pointer;" onclick="sortNatPlayerList(\'age\',\'' +
      list +
      "')\">Yaş" +
      natSortMark("age", list) +
      "</span>" +
      keys
        .map(function (sk) {
          const lab =
            typeof tacticsSkillShortLabel === "function"
              ? tacticsSkillShortLabel(sk)
              : String(sk).slice(0, 3);
          return (
            '<span class="tsh-skill" style="cursor:pointer;" title="' +
            sk +
            '" onclick="sortNatPlayerList(\'' +
            sk +
            "','" +
            list +
            "')\">" +
            lab +
            natSortMark(sk, list) +
            "</span>"
          );
        })
        .join("") +
      '<span class="tsh-action">İşlem</span></div>'
    );
  }
  function natSkillValuesHtml(p) {
    const keys = natSkillKeys();
    return keys
      .map(function (sk) {
        const val = Math.round(
          Number(p[sk]) || Number(p.skills && p.skills[sk]) || 0,
        );
        return '<span class="tsr-val">' + val + "</span>";
      })
      .join("");
  }
  /** Tek satır: isim (tıklanır) | kalite | takım | yaş | skills | Seç/Çıkar */
  function natPlayerRowHtml(p, opts) {
    opts = opts || {};
    const inSquad = !!opts.inSquad;
    const canManage = !!opts.canManage;
    const pid = String(p.playerId || "").replace(/'/g, "");
    const posFull = String(p.naturalPos || p.pos || "?")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    const nameLabel =
      (posFull ? escapeHtml(posFull) + " · " : "") + escapeHtml(p.name || "?");
    const nameHtml =
      '<span class="tsr-name"><a href="javascript:void(0)" class="nat-player-link" onclick="event.preventDefault();event.stopPropagation();openNationalCandidateProfile(\'' +
      pid +
      "')\" title=\"Profil\">" +
      nameLabel +
      "</a></span>";
    const qualityHtml =
      '<span class="tsr-quality">' + natAbilityBadge(p.overall) + "</span>";
    const teamHtml =
      '<span class="tsr-team" title="' +
      escapeHtml(p.clubName || "") +
      '">' +
      escapeHtml(p.clubName || "—") +
      "</span>";
    const ageHtml =
      '<span class="tsr-age">' + (p.age != null ? p.age : "—") + "</span>";
    let actionHtml = '<span class="tsr-action">';
    if (canManage) {
      if (inSquad) {
        actionHtml +=
          '<button type="button" class="sub-btn nat-act-btn nat-act-drop" onclick="event.stopPropagation();dropNationalPlayer(\'' +
          pid +
          "')\">Çıkar</button>";
      } else {
        actionHtml +=
          '<button type="button" class="sub-btn nat-act-btn nat-act-pick" onclick="event.stopPropagation();callUpNationalPlayer(\'' +
          pid +
          "')\">Seç</button>";
      }
    } else {
      actionHtml += "—";
    }
    actionHtml += "</span>";
    return (
      '<div class="tactics-skill-row nat-grid-row' +
      (inSquad ? " in-lineup" : "") +
      '">' +
      nameHtml +
      qualityHtml +
      teamHtml +
      ageHtml +
      natSkillValuesHtml(p) +
      actionHtml +
      "</div>"
    );
  }


  // _natLineup: seçili formasyonun her slotu için { pos, x, y, playerId|null }
  let _natLineup = [];
  let _natFormation = "4-4-2";
  let _natPassStyle = "kisa";
  let _natGameStyle = "dengeli";
  let _natAttackDir = "orta";
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
    // Kadro / Taktik yalnızca o milli takımın teknik direktörüne görünür —
    // diğer kullanıcılar için bu iki sekme tamamen gizlenir.
    const isMeManager = !!(_natState && _natState.team && _natState.team.isMeManager);
    const tacticBtn = document.getElementById("natSubtabTactic");
    const kadroBtn = document.getElementById("natSubtabKadro");
    if (tacticBtn) tacticBtn.style.display = isMeManager ? "" : "none";
    if (kadroBtn) kadroBtn.style.display = isMeManager ? "" : "none";
    // TD olmayan bir kullanıcı hâlâ "tactic"/"all" sekmesindeyse (ör. görevi
    // yeni bıraktıysa) erişilebilir bir sekmeye düşür.
    if (!isMeManager && (_natManageSub === "tactic" || _natManageSub === "all")) {
      _natManageSub = "groups";
    }
    document.querySelectorAll(".nat-manage-subtab").forEach((btn) => {
      const active = btn.dataset.sub === _natManageSub;
      btn.classList.toggle("active", active);
      btn.style.background = active ? "" : "#334155";
    });
  }

  /** Taktikler ana sayfasında Kulüp / A Milli / U21 modu değiştirir. */
  window.setTacticsMode = window.setTacticsMode || async function (mode) {
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
    if (natView) {
      natView.style.display = "block";
      natView.style.visibility = "visible";
    }
    // Yönetici değilse tactic yerine groups; yöneticiyse tactic
    _natCategory = _tacticsMode;
    const body = document.getElementById("tacticsNatBody");
    if (body) {
      body.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
    }
    let state = null;
    try {
      state = await fetchNationalState(_natCategory);
      await fetchNationalApplicationsIfAdmin(state);
    } catch (e) {
      console.warn("[em] setTacticsMode fetch", e);
    }
    if (!state) {
      if (body) {
        body.innerHTML =
          '<div style="color:#f87171;text-align:center;padding:16px;font-size:13px;">Milli takım bilgisi alınamadı. Bağlantını kontrol edip tekrar dene.</div>';
      }
      syncNationalManageTabs();
      return;
    }
    const isMgr = !!(state.team && state.team.isMeManager);
    _natManageSub = isMgr ? "tactic" : "groups";
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
    const pid = String(playerId || "");
    return (_natState?.squad || []).find((p) => String(p.playerId) === pid) || null;
  }

  async function fetchNationalState(category) {
    if (category) _natCategory = category === "U21" ? "U21" : "A";
    try {
      const state = await apiFetch(
        "/api/national/state?category=" + encodeURIComponent(_natCategory),
      );
      _natState = state;
      try {
        if (typeof setNationalManagerFlag === "function") {
          setNationalManagerFlag(!!(state.team && state.team.isMeManager));
        }
      } catch (e) {}
      _natFormation = (state.team && state.team.formation) || "4-4-2";
      _natPassStyle = (state.team && state.team.passStyle) || "kisa";
      _natGameStyle = (state.team && state.team.gameStyle) || "dengeli";
      _natAttackDir = (state.team && state.team.attackDir) || "orta";
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

  // Sunucu tarafı paylaşılan kura (localStorage YOK — tüm kullanıcılar aynı)
  let _natServerDraw = { A: null, U21: null };
  let _natServerRanking = { A: null, U21: null };

  async function fetchNationalGroupsFromServer(force) {
    const cat = _natCategory === "U21" ? "U21" : "A";
    try {
      const data = await apiFetch(
        "/api/national/groups?category=" + encodeURIComponent(cat),
      );
      _natServerDraw[cat] = data;
      if (data && data.ranking) _natServerRanking[cat] = data.ranking;
      return data;
    } catch (e) {
      console.warn("[em] national groups", e);
      return _natServerDraw[cat];
    }
  }

  function getNationalPots(rows) {
    const sorted = (rows || []).slice().sort(function (a, b) {
      return (b.pts || 0) - (a.pts || 0);
    });
    const pots = [[], [], [], []];
    sorted.forEach(function (r, i) {
      const pot = Math.min(3, Math.floor(i / 4));
      pots[pot].push(Object.assign({}, r, { pot: pot + 1 }));
    });
    return pots;
  }

  function getNationalGroupDraw(rows) {
    const cat = _natCategory === "U21" ? "U21" : "A";
    const cached = _natServerDraw[cat];
    if (cached && cached.groups && cached.groups.length === 4) {
      return cached.groups;
    }
    // Sunucu henüz gelmediyse torba sırasına göre deterministik geçici
    const pots = getNationalPots(rows);
    const groups = [[], [], [], []];
    for (let potIdx = 0; potIdx < 4; potIdx++) {
      for (let g = 0; g < 4; g++) {
        const team = pots[potIdx][g];
        if (team) groups[g].push(team);
      }
    }
    return groups;
  }

  // Yeniden kura kaldırıldı — kuralar sunucuda otomatik çekilir
  window.redrawNationalPots = function () {
    /* no-op: otomatik kura */
  };


  function buildNatCountryRows(which) {
    const flagFn =
      typeof countryFlag === "function" ? countryFlag : function () { return "🏳️"; };
    const cat = which === "U21" ? "U21" : "A";
    // Sunucu sıralaması (tüm kullanıcılarla senkron)
    const serverRank = _natServerRanking[cat] || (_natServerDraw[cat] && _natServerDraw[cat].ranking);
    if (serverRank && serverRank.length) {
      return serverRank.map(function (r) {
        return Object.assign({}, r, { flag: flagFn(r.c) });
      });
    }
    const names =
      typeof COUNTRY_NAMES !== "undefined" && Array.isArray(COUNTRY_NAMES)
        ? COUNTRY_NAMES
        : ["Türkiye", "Almanya", "Fransa", "İspanya", "İngiltere", "İtalya", "Portekiz", "Hollanda", "Belçika", "Hırvatistan", "Polonya", "Danimarka", "İsviçre", "Avusturya", "İsveç", "Sırbistan"];
    return names
      .map(function (c) {
        return { c: c, pts: 50, strength: 50, flag: flagFn(c) };
      })
      .sort(function (a, b) { return b.pts - a.pts; });
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
        if (t.isMeManager) {
          html +=
            '<div style="font-size:12px;color:#4ade80;margin-top:6px;">Teknik direktör sensin</div>';
        } else if (state.myApplication) {
          html +=
            '<div style="font-size:12px;color:#fbbf24;margin-top:6px;">Başvurun admin onayını bekliyor</div>';
        } else {
          html +=
            '<div style="font-size:12px;color:#94a3b8;margin-top:6px;">' +
            (t.isManagerVacant
              ? "Teknik direktör koltuğu boş"
              : "Teknik Direktör: <b>" +
                (t.managerClubName || "?") +
                "</b>") +
            "</div>" +
            '<button class="sub-btn" style="margin-top:8px;width:100%;background:linear-gradient(90deg,#38bdf8,#6366f1);font-weight:800;" onclick="applyNationalManager()">🏳️ Teknik Direktörlüğe Başvur</button>';
        }
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
        '<div class="formation-hint" style="margin-bottom:8px;">Torba sistemi: sıralamaya göre 4 torba · her gruba her torbadan 1 takım. Kuralar sunucuda otomatik çekilir — tüm oyuncular aynı grupları görür.</div>';
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
            '<div class="clickable-player" onclick="openCountryProfile(\'' +
            String(r.c || "").replace(/'/g, "\\'") +
            "','" +
            which +
            '\')" style="font-size:12px;color:#e2e8f0;padding:2px 0;cursor:pointer;text-decoration:underline;">' +
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
            String(r.c || "").replace(/'/g, "\\'") +
            "','" +
            which +
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
          String(r.c || "").replace(/'/g, "\\'") +
          "','" +
          which +
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
                escapeHtml(p.name) +
                " · " +
                escapeHtml(p.pos) +
                ' <span style="color:#94a3b8;">(' +
                escapeHtml(p.clubName || "-") +
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
    if (!info || !squadEl) return;
    if (!_natState) {
      squadEl.innerHTML =
        '<div style="color:#f87171;text-align:center;padding:16px;font-size:13px;">Milli takım verisi yok. A Milli / U21 sekmesine tekrar tıkla.</div>';
      return;
    }
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
          ? "Koltuk boş — başvuru gönderebilirsin"
          : "Teknik Direktör: <b>" +
            (t.managerClubName || "?") +
            "</b> — yine de başvuru gönderebilirsin") +
        "</div>" +
        '<button class="sub-btn" style="margin-top:8px;background:linear-gradient(90deg,#38bdf8,#6366f1);font-weight:800;" onclick="applyNationalManager()">🏳️ Teknik Direktörlüğe Başvur</button>';
    }

    if (state.isAdmin) {
      infoHtml += '<div class="youth-section-title" style="margin-top:10px;">Başvurular (Admin)</div>';
      infoHtml += _natApplications.length
        ? _natApplications
            .map(
              (a) =>
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.25);font-size:12px;color:#e2e8f0;">' +
                "<span>" +
                escapeHtml(a.username) +
                (a.clubName ? " · " + escapeHtml(a.clubName) : "") +
                (a.message
                  ? '<br><span style="color:#64748b;font-size:11px;">' + escapeHtml(a.message) + "</span>"
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
    let sub = infoSubs[_natManageSub]
      ? _natManageSub
      : _natManageSub === "all"
        ? "all"
        : "tactic";

    // Kadro / Taktik yalnızca teknik direktöre açık — güvenlik için
    // içerik seviyesinde de aynı kontrol tekrarlanır (sekme gizli olsa da
    // renderNationalManage başka bir yoldan tetiklenebilir).
    if ((sub === "all" || sub === "tactic") && !t.isMeManager) {
      sub = "groups";
      _natManageSub = "groups";
      syncNationalManageTabs();
    }

    // Gruplar / Sıralama / Fikstür / Krallık / Tarihçe / İstatistik
    // Yönet ekranında da aynı sekmeler aktif kalır (kaybolmaz).
    if (infoSubs[sub]) {
      renderNationalInfoContent(sub, squadEl, false);
      return;
    }

    if (sub === "all") {
      // -------- Seçilenler: kalite + sıralama + Seç/Çıkar --------
      const squadSorted = natSortPlayers(state.squad || [], "squad");
      const canManage = !!t.isMeManager;
      html +=
        '<div class="youth-section-title">⭐ Seçilenler (' +
        squadSorted.length +
        "/" +
        state.maxSquad +
        ')</div><div class="formation-hint">İsme tıkla → profil. Sütun başlığına tıkla → artan/azalan sırala. Seç / Çıkar ile kadroyu yönet.</div>';
      if (squadSorted.length) {
        html +=
          '<div class="nat-table-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px;">' +
          natSkillHeaderHtml("squad") +
          squadSorted
            .map(function (p) {
              return natPlayerRowHtml(p, { inSquad: true, canManage: canManage });
            })
            .join("") +
          "</div>";
      } else {
        html +=
          '<div style="color:#64748b;font-size:12px;padding:0 0 10px;">Henüz seçilen oyuncu yok — aşağıdaki listeden Seç.</div>';
      }

      if (canManage && squadSorted.length > 0) {
        html +=
          '<button class="sub-btn" style="width:100%;margin-bottom:14px;background:linear-gradient(90deg,#059669,#10b981);font-weight:800;" onclick="openNationalLineupExplain()">📋 Kadroyu Açıkla</button>';
      }

      // -------- Tüm Oyuncular (havuz) --------
      const poolSorted = natSortPlayers(state.candidates || [], "pool");
      html +=
        '<div class="formation-hint">Kadroya henüz çağrılmamış tüm ' +
        (t.country || "") +
        (_natCategory === "U21" ? " U21" : " A") +
        " uygun oyuncular. Sütuna tıklayarak sırala.</div>";
      if (!canManage) {
        html +=
          '<div style="color:#94a3b8;font-size:12px;padding:8px 0;">Oyuncu seçmek için bu takımın teknik direktörü olman gerekiyor.</div>';
      }
      html += poolSorted.length
        ? '<div class="youth-section-title">Tüm Oyuncular (' +
          poolSorted.length +
          ')</div><div class="nat-table-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">' +
          natSkillHeaderHtml("pool") +
          poolSorted
            .map(function (p) {
              return natPlayerRowHtml(p, { inSquad: false, canManage: canManage });
            })
            .join("") +
          "</div>"
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

      // Önce yedek/kadro listesi, sonra özel taktikler (yerleri değiştirildi)
    }

    html += (state.squad || []).length
      ? '<div class="youth-section-title" style="margin-top:8px;">Kadro / Yedekler' +
        (t.isMeManager
          ? ' <span style="color:#facc15;font-weight:400;font-size:11px;">— isme tıkla, sonra sahaya yerleştir</span>'
          : "") +
        '</div><div style="overflow-x:auto;-webkit-overflow-scrolling:touch;">' +
        natSkillHeaderHtml() +
        state.squad
          .map((p) => {
            const slotIdx = _natLineup.findIndex((s) => s.playerId === p.playerId);
            const isSel = slotIdx !== -1;
            const posPrefix = isSel ? _natLineup[slotIdx].pos + " · " : (p.pos ? p.pos + " · " : "");
            const selectedCls =
              _natSelectedPlayerId && String(_natSelectedPlayerId) === String(p.playerId)
                ? " selected"
                : "";
            const lineupCls = isSel ? " in-lineup" : "";
            const rowClick = t.isMeManager
              ? ' onclick="placeNationalPlayer(\'' +
                String(p.playerId).replace(/'/g, "") +
                '\')"'
              : "";
            return (
              '<div class="tactics-skill-row' +
              selectedCls +
              lineupCls +
              '"' +
              rowClick +
              ">" +
              '<span class="tsr-name">' +
              posPrefix +
              escapeHtml(p.name) +
              " · " +
              fmtNatOverall(p.overall) +
              (isSel ? " · İLK11" : " · YEDEK") +
              "</span>" +
              natSkillValuesHtml(p) +
              "</div>"
            );
          })
          .join("") +
        "</div>"
      : '<div style="color:#64748b;font-size:12px;padding:8px;">Henüz çağrılmış oyuncu yok.</div>';

    if (t.isMeManager) {
      // Özel taktikler yedeklerden sonra
      html += '<div class="youth-section-title" style="margin-top:12px;">Özel Taktikler</div>';
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
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:12px 0 10px;padding-top:12px;border-top:1px solid #2c3a52;">' +
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
        "</select></div>" +
        '<div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Hücum Yönü</div>' +
        '<select style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;" onchange="_natAttackDir=this.value">' +
        [
          ["orta", "Orta"],
          ["kanat", "Kanat"],
          ["sol", "Sol Kanat"],
          ["sag", "Sağ Kanat"],
        ]
          .map(
            ([v, label]) =>
              '<option value="' +
              v +
              '"' +
              (v === _natAttackDir ? " selected" : "") +
              ">" +
              label +
              "</option>",
          )
          .join("") +
        "</select></div></div>";

      html +=
        '<div class="formation-hint" style="margin-top:6px;">Kadroya oyuncu eklemek için <b>👥 Tüm Oyuncular</b> sekmesine geç.</div>';
      html +=
        '<button class="sub-btn" style="width:100%;margin-top:12px;" onclick="saveNationalLineupClick()">İlk 11, Taktik &amp; Formasyonu Kaydet</button>';
    }

    squadEl.innerHTML = html;
  }

  window.goToNationalTeams = window.goToNationalTeams || async function () {
    hideMainMenuAndShowBack();
    switchPage("page-national");
    // Fikstür yoksa kulüp ülkesi için A + U21 dostluk üret
    try {
      await apiFetch("/api/national/ensure-fixtures", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (e) {
      console.warn("[em] national ensure-fixtures", e);
    }
    // A sekmesi aktif görünsün
    const tabA = document.getElementById("natTabA");
    const tabU21 = document.getElementById("natTabU21");
    if (tabA) tabA.style.background = "";
    if (tabU21) tabU21.style.background = "#334155";
    const state = await fetchNationalState("A");
    renderNationalOverview(state);
  };
  window.showNationalTab = window.showNationalTab || async function (which) {
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
    await fetchNationalGroupsFromServer();
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
      try {
        const htmlFn =
          typeof window.natKitEditorHtml === "function"
            ? window.natKitEditorHtml
            : null;
        if (htmlFn) {
          list.innerHTML = htmlFn();
          if (typeof window.refreshKitAccessFor === "function") {
            window.refreshKitAccessFor("natKit", "national");
          }
        } else {
          list.innerHTML =
            '<div style="color:#f87171;padding:16px;text-align:center;">Forma editörü yüklenemedi. Sayfayı yenile (Ctrl+F5).</div>';
        }
      } catch (eKit) {
        list.innerHTML =
          '<div style="color:#f87171;padding:16px;text-align:center;">Forma: ' +
          ((eKit && eKit.message) || eKit) +
          "</div>";
      }
      return;
    }
    // State yoksa önce yükle
    if (!_natState) {
      list.innerHTML =
        '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
      Promise.all([
        fetchNationalState(_natCategory),
        fetchNationalGroupsFromServer(),
      ]).then(function (arr) {
        renderNationalOverview(arr[0]);
      });
      return;
    }
    renderNationalOverview(_natState);
  };

  window.openCountryProfile = async function (country, category) {
    if (!country) return;
    // A ve U21 ayrı veri — parametre veya aktif milli sekme
    const cat =
      category === "U21" || category === "A"
        ? category
        : _natCategory === "U21"
          ? "U21"
          : "A";
    const modal = document.getElementById("genericModal") || document.getElementById("modalOverlay");
    // Basit overlay
    let box = document.getElementById("emCountryProfileModal");
    if (!box) {
      box = document.createElement("div");
      box.id = "emCountryProfileModal";
      box.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;";
      document.body.appendChild(box);
    }
    box.style.display = "flex";
    box.innerHTML =
      '<div style="background:#0f172a;border:1px solid #2c3a52;border-radius:14px;max-width:480px;width:100%;max-height:85vh;overflow:auto;padding:16px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<div style="font-weight:800;font-size:16px;color:#e2e8f0;">Yükleniyor…</div>' +
      '<button type="button" style="background:#334155;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;" onclick="document.getElementById(\'emCountryProfileModal\').style.display=\'none\'">Kapat</button></div>' +
      '<div style="color:#94a3b8;font-size:13px;">Ülke profili getiriliyor (' +
      cat +
      ")…</div></div>";
    try {
      const p = await apiFetch(
        "/api/national/country-profile?country=" +
          encodeURIComponent(country) +
          "&category=" +
          encodeURIComponent(cat),
      );
      const flag =
        typeof countryFlag === "function" ? countryFlag(p.country) : "🏳️";
      const mgr = p.manager || {};
      let standHtml = "";
      (p.standings || []).forEach(function (tm, i) {
        standHtml +=
          '<div style="display:flex;gap:8px;padding:6px 4px;border-bottom:1px solid #1e293b;font-size:12px;">' +
          '<span style="width:20px;color:#64748b;">' +
          (i + 1) +
          '</span><span style="flex:1;color:#e2e8f0;">' +
          (tm.name || "?") +
          (tm.isBot ? ' <span style="color:#64748b;">(AI)</span>' : "") +
          '</span><span style="color:#94a3b8;">' +
          (tm.played || 0) +
          ' O</span><span style="font-weight:700;color:#38bdf8;">' +
          (tm.pts || 0) +
          " p</span></div>";
      });
      let fxHtml = "";
      (p.recentFixtures || []).forEach(function (f) {
        fxHtml +=
          '<div style="font-size:12px;color:#cbd5e1;padding:4px 0;border-bottom:1px solid #1e293b;">' +
          (p.country || "") +
          " <b>" +
          (f.homeGoals != null ? f.homeGoals : "-") +
          "-" +
          (f.awayGoals != null ? f.awayGoals : "-") +
          "</b> " +
          (f.opponentName || "?") +
          "</div>";
      });
      box.innerHTML =
        '<div style="background:#0f172a;border:1px solid #2c3a52;border-radius:14px;max-width:480px;width:100%;max-height:85vh;overflow:auto;padding:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
        '<div style="font-weight:800;font-size:17px;color:#e2e8f0;">' +
        flag +
        " " +
        p.country +
        (cat === "U21" ? " U21" : " A Milli") +
        "</div>" +
        '<button type="button" style="background:#334155;color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;" onclick="document.getElementById(\'emCountryProfileModal\').style.display=\'none\'">Kapat</button></div>' +
        '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
        '<button type="button" style="flex:1;padding:7px;border-radius:8px;border:0;cursor:pointer;font-weight:800;font-size:12px;' +
        (cat === "A"
          ? "background:linear-gradient(90deg,#0369a1,#0ea5e9);color:#fff;"
          : "background:#1e293b;color:#94a3b8;") +
        "\" onclick=\"openCountryProfile('" +
        String(p.country || "").replace(/'/g, "\\'") +
        "', 'A')\">A Milli</button>" +
        '<button type="button" style="flex:1;padding:7px;border-radius:8px;border:0;cursor:pointer;font-weight:800;font-size:12px;' +
        (cat === "U21"
          ? "background:linear-gradient(90deg,#0369a1,#0ea5e9);color:#fff;"
          : "background:#1e293b;color:#94a3b8;") +
        "\" onclick=\"openCountryProfile('" +
        String(p.country || "").replace(/'/g, "\\'") +
        "', 'U21')\">U21</button>" +
        "</div>" +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">' +
        '<div style="background:#111827;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#64748b;">Sıralama</div><div style="font-size:18px;font-weight:800;color:#facc15;">#' +
        (p.rank || "-") +
        '</div></div>' +
        '<div style="background:#111827;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#64748b;">Güç / Puan</div><div style="font-size:18px;font-weight:800;color:#38bdf8;">' +
        (p.strength || 0) +
        " · " +
        (p.pts || 0) +
        "</div></div>" +
        '<div style="background:#111827;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#64748b;">Teknik Direktör</div><div style="font-size:13px;font-weight:700;color:#e2e8f0;">' +
        (mgr.vacant
          ? "Boş"
          : escapeHtml(mgr.username || "?") +
            (mgr.clubName ? " · " + escapeHtml(mgr.clubName) : "")) +
        "</div></div>" +
        '<div style="background:#111827;border-radius:10px;padding:10px;"><div style="font-size:11px;color:#64748b;">Lig kulüpleri</div><div style="font-size:13px;font-weight:700;color:#e2e8f0;">' +
        (p.clubCount || 0) +
        " (" +
        (p.humanClubs || 0) +
        " insan / " +
        (p.botClubs || 0) +
        " AI)</div></div>" +
        "</div>" +
        '<div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">🏟️ ' +
        (p.nationalArena || "") +
        " · Kapasite " +
        (p.capacity ? Number(p.capacity).toLocaleString("tr-TR") : "-") +
        " · Formasyon " +
        (p.formation || "4-4-2") +
        "</div>" +
        '<button type="button" class="sub-btn" style="width:100%;margin:8px 0 12px;padding:10px;font-weight:800;background:linear-gradient(90deg,#0369a1,#0ea5e9);color:#fff;border:none;border-radius:10px;cursor:pointer;" onclick="window.__emToggleCountrySquad && window.__emToggleCountrySquad()">👥 Kadroyu Gör (Son Maç)</button>' +
        '<div id="emCountrySquadPanel" style="display:none;margin-bottom:12px;"></div>' +
        '<div class="youth-section-title">1. Lig Puan Durumu</div>' +
        (standHtml ||
          '<div style="color:#64748b;font-size:12px;">Lig verisi yok</div>') +
        (fxHtml
          ? '<div class="youth-section-title" style="margin-top:12px;">Son Milli Maçlar</div>' +
            fxHtml
          : "") +
        "</div>";
      // Son maç kadrosu paneli (toggle)
      window.__emCountryProfileLastMatch = p.lastMatch || null;
      window.__emToggleCountrySquad = function () {
        const panel = document.getElementById("emCountrySquadPanel");
        if (!panel) return;
        if (panel.style.display !== "none") {
          panel.style.display = "none";
          return;
        }
        const lm = window.__emCountryProfileLastMatch;
        if (!lm || (!(lm.starters || []).length && !(lm.bench || []).length)) {
          panel.style.display = "block";
          panel.innerHTML =
            '<div style="color:#94a3b8;font-size:12px;padding:8px;background:#111827;border-radius:10px;">Kadro bilgisi yok — henüz oyuncu çağrılmamış veya maç oynanmamış.</div>';
          return;
        }
        function rowHtml(pl, tag) {
          return (
            '<div style="display:flex;gap:8px;align-items:center;padding:5px 4px;border-bottom:1px solid #1e293b;font-size:12px;">' +
            '<span style="width:36px;color:#38bdf8;font-weight:800;">' +
            escapeHtml(pl.pos || pl.naturalPos || "?") +
            '</span><span style="flex:1;color:#e2e8f0;">' +
            escapeHtml(pl.name || "?") +
            '</span><span style="color:#94a3b8;font-size:11px;">' +
            escapeHtml(pl.clubName || "") +
            '</span><span style="color:#facc15;font-weight:700;width:28px;text-align:right;">' +
            (pl.overall != null ? pl.overall : "—") +
            "</span>" +
            (tag
              ? '<span style="font-size:10px;color:#64748b;margin-left:4px;">' +
                tag +
                "</span>"
              : "") +
            "</div>"
          );
        }
        let head = '<div class="youth-section-title" style="margin:0 0 6px;">Son Maç Kadrosu</div>';
        if (lm.opponentName) {
          head +=
            '<div style="font-size:12px;color:#cbd5e1;margin-bottom:8px;">' +
            escapeHtml(p.country || "") +
            " <b>" +
            (lm.homeGoals != null ? lm.homeGoals : "-") +
            "-" +
            (lm.awayGoals != null ? lm.awayGoals : "-") +
            "</b> " +
            escapeHtml(lm.opponentName) +
            (lm.formation
              ? ' · <span style="color:#94a3b8;">' +
                escapeHtml(lm.formation) +
                "</span>"
              : "") +
            "</div>";
        } else if (lm.note) {
          head +=
            '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">' +
            escapeHtml(lm.note) +
            "</div>";
        }
        const st = (lm.starters || [])
          .slice()
          .sort(function (a, b) {
            return String(a.pos || "").localeCompare(String(b.pos || ""));
          })
          .map(function (pl) {
            return rowHtml(pl, "İlk 11");
          })
          .join("");
        const bn = (lm.bench || [])
          .slice()
          .sort(function (a, b) {
            return (b.overall || 0) - (a.overall || 0);
          })
          .map(function (pl) {
            return rowHtml(pl, "Yedek");
          })
          .join("");
        panel.style.display = "block";
        panel.innerHTML =
          '<div style="background:#111827;border-radius:10px;padding:10px;">' +
          head +
          (st
            ? '<div style="font-size:11px;color:#64748b;margin:6px 0 2px;">İlk 11</div>' +
              st
            : '<div style="color:#64748b;font-size:12px;">İlk 11 boş</div>') +
          (bn
            ? '<div style="font-size:11px;color:#64748b;margin:10px 0 2px;">Yedekler</div>' +
              bn
            : "") +
          "</div>";
      };
    } catch (e) {
      box.innerHTML =
        '<div style="background:#0f172a;border:1px solid #2c3a52;border-radius:14px;padding:16px;color:#f87171;">Profil yüklenemedi: ' +
        (e.message || e) +
        '<br><button style="margin-top:10px;" onclick="document.getElementById(\'emCountryProfileModal\').style.display=\'none\'">Kapat</button></div>';
    }
  };

    window.goToNationalManage = async function () {
    hideMainMenuAndShowBack();
    switchPage("page-tactics");
    // Yönet ekranında da aynı alt sekmeler erişilebilir kalsın
    _natManageSub = "tactic";
    // Not: setTacticsMode artık güncel (index.html) implementasyonuna
    // işaret ediyor ve doğru görünümü (kulüple aynı saha UI) kendisi
    // gösterip dolduruyor. Eskiden burada natView'i zorla tekrar
    // görünür yapıp eski renderNationalManage() ile dolduruyorduk;
    // bu, yeni ekranın üzerine boş/"Yükleniyor…" yazan eski paneli
    // bindiriyordu çünkü o panel artık hiç beslenmiyor. Bu yüzden
    // setTacticsMode'un sonucuna güveniyoruz ve üzerine yazmıyoruz.
    await window.setTacticsMode(_natCategory === "U21" ? "U21" : "A");
  };

  /** Kadro sekmesinden "Kadroyu Açıkla" — dizilişi kaydet + kamu duyurusu */
  window.openNationalLineupExplain = async function () {
    _tacticsMode = _natCategory === "U21" ? "U21" : "A";
    try {
      const clubView = document.getElementById("tacticsClubView");
      const natView = document.getElementById("tacticsNationalView");
      if (clubView) clubView.style.display = "none";
      if (natView) {
        natView.style.display = "block";
        natView.style.visibility = "visible";
      }
      const page = document.getElementById("page-tactics");
      if (page && !page.classList.contains("active")) {
        if (typeof hideMainMenuAndShowBack === "function")
          hideMainMenuAndShowBack();
        if (typeof switchPage === "function") switchPage("page-tactics");
      }
    } catch (e) {}
    if (!_natState) {
      try {
        await fetchNationalState(_natCategory);
        await fetchNationalApplicationsIfAdmin(_natState);
      } catch (e) {}
    }
    if (!_natState) {
      alert("Milli takım yüklenemedi. Tekrar dene.");
      return;
    }
    if (!(_natState.team && _natState.team.isMeManager)) {
      alert("Kadroyu açıklamak yalnızca teknik direktöre açıktır.");
      return;
    }

    // Kadro seçilmiş oyuncuları taktik dizilişine aktar (boşsa veya eksikse doldur)
    try {
      if (!_natLineup || !_natLineup.length || !_natLineup.some(function (s) { return s.playerId; })) {
        _natLineup = buildNationalLineupFromSquad(_natState, _natFormation || "4-4-2");
      } else {
        // Seçili kadrodaki yeni oyuncuları yedek/boş slotlara ekle
        const used = new Set((_natLineup || []).map(function (s) { return s.playerId; }).filter(Boolean));
        const squad = _natState.squad || [];
        squad.forEach(function (p) {
          if (p && p.playerId && !used.has(p.playerId)) {
            const empty = (_natLineup || []).find(function (s) { return !s.playerId; });
            if (empty) {
              empty.playerId = p.playerId;
              used.add(p.playerId);
            }
          }
        });
      }
    } catch (e) {
      console.warn("[em] lineup from squad", e);
    }

    // Dizilişi sunucuya kaydet (mümkünse)
    try {
      if (typeof window.saveNationalLineupClick === "function") {
        await window.saveNationalLineupClick();
      }
    } catch (e) {
      console.warn("[em] kadro kaydet", e);
    }

    const country = (_natState.team && _natState.team.country) || "Milli";
    const catLabel = _natCategory === "U21" ? " U21" : " A";
    const form = _natFormation || "4-4-2";
    const lines = [];
    (_natLineup || []).forEach(function (slot) {
      const p = slot.playerId ? natSquadPlayerById(slot.playerId) : null;
      if (p) {
        lines.push(
          (slot.pos || p.pos || "?") +
            " · " +
            (p.name || "?") +
            (p.clubName ? " (" + p.clubName + ")" : ""),
        );
      } else {
        lines.push((slot.pos || "?") + " · —");
      }
    });
    const squadExtra = (_natState.squad || [])
      .filter(function (p) {
        return !(_natLineup || []).some(function (s) {
          return s.playerId === p.playerId;
        });
      })
      .map(function (p) {
        return (
          (p.naturalPos || p.pos || "?") +
          " · " +
          p.name +
          (p.clubName ? " (" + p.clubName + ")" : "")
        );
      });

    const title =
      "🏳️ " + country + catLabel + " kadrosu açıklandı (" + form + ")";
    const bodyText =
      "İlk 11:\n" +
      lines.join("\n") +
      (squadExtra.length
        ? "\n\nYedekler / kadro:\n" + squadExtra.join("\n")
        : "");

    try {
      if (typeof pushNotification === "function")
        pushNotification("🏳️", title, "Milli");
    } catch (e) {}
    try {
      if (typeof addLog === "function") addLog(title, "development");
    } catch (e) {}
    // Forum/duyuru denemesi
    try {
      await apiFetch("/api/forum", {
        method: "POST",
        body: JSON.stringify({
          text: title + "\n\n" + bodyText,
          category: "milli",
        }),
      });
    } catch (e) {
      /* forum yoksa sessiz geç */
    }

    // Açıklama paneli (taktik sekmesine geç + özet göster)
    _natManageSub = "tactic";
    syncNationalManageTabs();
    renderNationalManage();
    alert(title + "\n\n" + bodyText);
    try {
      const body = document.getElementById("tacticsNatBody");
      if (body) body.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {}
  };
  window.showNationalManageSub = window.showNationalManageSub || async function (sub) {
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
    // Taktik sayfasına geçişte görünümü garantile
    try {
      const clubView = document.getElementById("tacticsClubView");
      const natView = document.getElementById("tacticsNationalView");
      if (_tacticsMode === "A" || _tacticsMode === "U21") {
        if (clubView) clubView.style.display = "none";
        if (natView) {
          natView.style.display = "block";
          natView.style.visibility = "visible";
        }
      }
    } catch (e) {}
    // State yoksa veya kategori değiştiyse yükle
    if (!_natState || (_natState.team && _natState.team.category && _natState.team.category !== _natCategory && !(_natCategory === "A" && !_natState.team.category))) {
      const body = document.getElementById("tacticsNatBody");
      if (body)
        body.innerHTML =
          '<div style="color:#64748b;text-align:center;padding:16px;">Yükleniyor…</div>';
      try {
        await fetchNationalState(_natCategory);
        await fetchNationalApplicationsIfAdmin(_natState);
      } catch (e) {
        console.warn("[em] showNationalManageSub fetch", e);
      }
    }
    if (!_natState) {
      const body = document.getElementById("tacticsNatBody");
      if (body)
        body.innerHTML =
          '<div style="color:#f87171;text-align:center;padding:16px;">Milli takım yüklenemedi.</div>';
      return;
    }
    syncNationalManageTabs();
    renderNationalManage();
    // Taktik sekmesine scroll
    if (_natManageSub === "tactic") {
      try {
        const body = document.getElementById("tacticsNatBody");
        if (body) body.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {}
    }
  };

  window.applyNationalManager = async function () {
    try {
      let message = "";
      try {
        message = window.prompt(
          "İsteğe bağlı mesaj (admin görür):",
          "",
        );
        if (message === null) return; // iptal
      } catch (e) {}
      await apiFetch("/api/national/apply", {
        method: "POST",
        body: JSON.stringify({
          category: _natCategory,
          message: message || undefined,
        }),
      });
      const state = await fetchNationalState();
      await fetchNationalApplicationsIfAdmin(state);
      try {
        renderNationalManage();
      } catch (e) {}
      try {
        if (typeof renderNationalOverview === "function")
          renderNationalOverview(state);
      } catch (e) {}
      alert("Başvurun gönderildi. Admin onayını bekliyor.");
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

  // Seç / Çıkar — API + hem index.html hem MC UI yenilemesi
  window.callUpNationalPlayer = async function (playerId) {
    const pid = String(playerId || "");
    if (!pid) {
      alert("Oyuncu kimliği yok");
      return;
    }
    const cat =
      (typeof window._tacticsMode === "string" &&
        (window._tacticsMode === "U21" || window._tacticsMode === "A") &&
        window._tacticsMode) ||
      _natCategory ||
      "A";
    try {
      _natScrollPreserve = _captureNatScroll();
      _natCategory = cat === "U21" ? "U21" : "A";
      await apiFetch("/api/national/squad/call", {
        method: "POST",
        body: JSON.stringify({ playerId: pid, category: _natCategory }),
      });
      let refreshed = false;
      try {
        if (typeof window.loadNationalTacticsState === "function") {
          await window.loadNationalTacticsState(true);
        }
        if (typeof window.renderNationalTacticsBody === "function") {
          await window.renderNationalTacticsBody(false);
          refreshed = true;
        }
      } catch (e1) {
        console.warn("[em] callUp refresh index UI", e1);
      }
      // index.html yolu başarılıysa MC render'ı üzerine yazmasın
      if (!refreshed) {
        try {
          await fetchNationalState(_natCategory);
          _natManageSub = "all";
          if (typeof renderNationalManage === "function") renderNationalManage();
        } catch (e2) {
          console.warn("[em] callUp refresh MC UI", e2);
        }
      } else {
        try {
          await fetchNationalState(_natCategory);
        } catch (e3) {}
      }
      _restoreNatScroll();
    } catch (e) {
      _natScrollPreserve = null;
      alert((e && e.message) || "Çağrı başarısız");
    }
  };
  window.dropNationalPlayer = async function (playerId) {
    const pid = String(playerId || "");
    if (!pid) {
      alert("Oyuncu kimliği yok");
      return;
    }
    const cat =
      (typeof window._tacticsMode === "string" &&
        (window._tacticsMode === "U21" || window._tacticsMode === "A") &&
        window._tacticsMode) ||
      _natCategory ||
      "A";
    try {
      _natScrollPreserve = _captureNatScroll();
      _natCategory = cat === "U21" ? "U21" : "A";
      await apiFetch("/api/national/squad/drop", {
        method: "POST",
        body: JSON.stringify({ playerId: pid, category: _natCategory }),
      });
      let refreshed = false;
      try {
        if (typeof window.loadNationalTacticsState === "function") {
          await window.loadNationalTacticsState(true);
        }
        if (typeof window.renderNationalTacticsBody === "function") {
          await window.renderNationalTacticsBody(false);
          refreshed = true;
        }
      } catch (e1) {
        console.warn("[em] drop refresh index UI", e1);
      }
      if (!refreshed) {
        try {
          await fetchNationalState(_natCategory);
          _natManageSub = "all";
          if (typeof renderNationalManage === "function") renderNationalManage();
        } catch (e2) {
          console.warn("[em] drop refresh MC UI", e2);
        }
      } else {
        try {
          await fetchNationalState(_natCategory);
        } catch (e3) {}
      }
      _restoreNatScroll();
    } catch (e) {
      _natScrollPreserve = null;
      alert((e && e.message) || "İşlem başarısız");
    }
  };
  window.setNationalFormation = function (formation) {
    // Millilerde orta saha (MC/DM/OMC) sayısı serbest — formasyon kısıtı yok
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
  /** Mevcut dizilişte (kaleci hariç) hat bazında oyuncu sayısını döner.
   *  centerMid: MC/DM/OMC (kanat ML/MR hariç) — milli üst sınır 3. */
  function natLineCounts() {
    let def = 0,
      mid = 0,
      fw = 0,
      centerMid = 0;
    const centerKeys = ["MC", "DM", "OMC", "OM"];
    _natLineup.forEach((s) => {
      if (!s) return;
      const pos = String(s.pos || "").toUpperCase();
      const band = typeof getZoneBand === "function" ? getZoneBand(s.pos) : null;
      if (band === "DF") def++;
      else if (band === "FW") fw++;
      else if (band && band !== "GK") mid++;
      if (centerKeys.includes(pos)) centerMid++;
    });
    return { def, mid, fw, centerMid };
  }

  /** Bir mevkinin hangi hatta (def/mid/fw) sayıldığını döner, kaleci/tanımsız için null. */
  function natLineCategory(pos) {
    const band = typeof getZoneBand === "function" ? getZoneBand(pos) : null;
    if (band === "DF") return "def";
    if (band === "FW") return "fw";
    if (band && band !== "GK") return "mid";
    return null;
  }

  // Diziliş kuralı: en az 3 defans, 2 orta saha, 1 forvet.
  // Orta saha (MC/DM/OMC) ve DC sayısı serbest — istenen sayıda konabilir.
  const NAT_MIN_LINE_COUNTS = { def: 3, mid: 2, fw: 1 };
  const NAT_MAX_PER_POS = {};

  window.handleNationalPitchClick = function (kind, index, zx, zy, zpos) {
    // Seçili oyuncu varsa: tıklanan slota yerleştir
    if (_natSelectedPlayerId && _natSelectedSlot === null) {
      const playerId = _natSelectedPlayerId;
      let targetIdx = null;
      if (kind === "slot") targetIdx = index;
      else if (kind === "zone") {
        // Boş zone: aynı pos'lu boş slot veya yeni koordinata uygun slot
        targetIdx = _natLineup.findIndex(function (s) {
          return !s.playerId && String(s.pos).toUpperCase() === String(zpos || "").toUpperCase();
        });
        if (targetIdx < 0) {
          targetIdx = _natLineup.findIndex(function (s) { return !s.playerId; });
        }
        if (targetIdx >= 0 && zpos) {
          _natLineup[targetIdx].pos = zpos;
          if (zx != null) _natLineup[targetIdx].x = zx;
          if (zy != null) _natLineup[targetIdx].y = zy;
        }
      }
      if (targetIdx == null || targetIdx < 0) {
        alert("Uygun saha bölgesi bulunamadı.");
        return;
      }
      const fromIdx = _natLineup.findIndex(function (s) {
        return String(s.playerId) === String(playerId);
      });
      if (fromIdx !== -1 && fromIdx !== targetIdx) {
        const tmp = _natLineup[targetIdx].playerId;
        _natLineup[targetIdx].playerId = playerId;
        _natLineup[fromIdx].playerId = tmp;
      } else if (fromIdx === -1) {
        _natLineup[targetIdx].playerId = playerId;
      }
      _natSelectedPlayerId = null;
      _natSelectedSlot = null;
      renderNationalManage();
      return;
    }
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
      const aIsGk = String(a.pos).toUpperCase() === "GK";
      const bIsGk = String(b.pos).toUpperCase() === "GK";
      if (aIsGk !== bIsGk) {
        alert("Kaleci kaleden çıkarılamaz. Sadece kaleci–kaleci yer değişimi yapılabilir.");
        _natSelectedSlot = null;
        renderNationalManage();
        return;
      }
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
    // Kaleciyi kaleden çıkarma
    if (String(fromPos).toUpperCase() === "GK" && String(zpos).toUpperCase() !== "GK") {
      alert("Kaleci kaleden çıkarılamaz.");
      _natSelectedSlot = null;
      renderNationalManage();
      return;
    }
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
      // MC / DM / OMC / DC pozisyon başına üst sınır
      const toPosUp = String(zpos || "").toUpperCase();
      if (NAT_MAX_PER_POS[toPosUp] != null) {
        let countAtPos = 0;
        _natLineup.forEach((s, idx) => {
          if (!s) return;
          let pos = String(s.pos || "").toUpperCase();
          if (idx === _natSelectedSlot) pos = toPosUp;
          if (pos === toPosUp) countAtPos++;
        });
        if (countAtPos > NAT_MAX_PER_POS[toPosUp]) {
          alert(
            "Milli diziliş: " +
              toPosUp +
              " mevkisinde en fazla " +
              NAT_MAX_PER_POS[toPosUp] +
              " oyuncu olabilir.",
          );
          _natSelectedSlot = null;
          renderNationalManage();
          return;
        }
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
    // Kulüp ile aynı: önce isme tıkla (oyuncu seç), sonra sahaya yerleştir
    if (_natSelectedSlot === null) {
      if (_natSelectedPlayerId && String(_natSelectedPlayerId) === String(playerId)) {
        _natSelectedPlayerId = null;
      } else {
        _natSelectedPlayerId = playerId;
      }
      renderNationalManage();
      return;
    }
    const targetIdx = _natSelectedSlot;
    const fromIdx = _natLineup.findIndex((s) => String(s.playerId) === String(playerId));
    if (fromIdx !== -1 && fromIdx !== targetIdx) {
      const tmp = _natLineup[targetIdx].playerId;
      _natLineup[targetIdx].playerId = playerId;
      _natLineup[fromIdx].playerId = tmp;
    } else if (fromIdx === -1) {
      _natLineup[targetIdx].playerId = playerId;
    }
    _natSelectedSlot = null;
    _natSelectedPlayerId = null;
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
    const lockedAttack = _natAttackDir;
    try {
      await apiFetch("/api/national/squad/lineup", {
        method: "POST",
        body: JSON.stringify({
          starterPlayerIds,
          formation: lockedFormation,
          assignments,
          passStyle: lockedPass,
          gameStyle: lockedGame,
          attackDir: lockedAttack,
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
      _natAttackDir = lockedAttack;
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

  // ---- Sunucu bağlantı durumu (öncelik 1) ----
  let _emServerOnline = null; // null=bilinmiyor, true/false
  window.__emIsServerOnline = function () {
    return !!_emServerOnline;
  };
  async function probeServerHealth() {
    try {
      // GÜVENLİK/UX: sınırsız bekleme yerine ~20 sn'lik bir üst sınır —
      // sunucu (Render cold start vb.) çok yavaş/erişilemez durumdaysa
      // istek sonsuza kadar askıda kalmasın, kullanıcıya makul sürede
      // "sunucu yok" bilgisi dönebilelim.
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(API_BASE + "/api/health", {
          method: "GET",
          signal: controller.signal,
        });
        _emServerOnline = res.ok;
        let data = null;
        try {
          data = await res.json();
        } catch (eJ) {}
        if (data && data.maintenance) {
          window.__emMaintenance = true;
          window.__emMaintenanceMsg =
            data.message || data.error || "Bakım çalışması sürüyor.";
        } else if (res.ok) {
          window.__emMaintenance = false;
        }
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      _emServerOnline = false;
    }
    updateServerStatusUI();
    try {
      if (typeof window.__emSetMaintenance === "function") {
        window.__emSetMaintenance(
          !!window.__emMaintenance,
          window.__emMaintenanceMsg,
        );
      }
    } catch (eM) {}
    return _emServerOnline;
  }
  function updateServerStatusUI() {
    const tt =
      typeof window.t === "function"
        ? window.t
        : function (k) {
            return k;
          };
    let txt =
      _emServerOnline === true
        ? tt("server_online")
        : _emServerOnline === false
          ? tt("server_offline")
          : tt("server_check");
    let col =
      _emServerOnline === true
        ? "#4ade80"
        : _emServerOnline === false
          ? "#f87171"
          : "#94a3b8";
    if (window.__emMaintenance && _emServerOnline) {
      txt = "🛠️ Bakım modu";
      col = "#fbbf24";
    }
    ["emServerStatus", "loginServerStatus"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) {
        el.innerText = txt;
        el.style.color = col;
      }
    });
  }
  window.__emSetMaintenance = function (on, msg) {
    window.__emMaintenance = !!on;
    window.__emMaintenanceMsg = msg || "";
    try {
      const ban = document.getElementById("maintenanceBanner");
      const banMsg = document.getElementById("maintenanceBannerMsg");
      if (ban) {
        if (on) ban.classList.add("visible");
        else ban.classList.remove("visible");
      }
      if (banMsg && msg) banMsg.textContent = msg;
      if (on) document.body.classList.add("maintenance-on");
      else document.body.classList.remove("maintenance-on");
    } catch (e) {}
    try {
      updateServerStatusUI();
    } catch (e2) {}
  };
  window.__emProbeServer = probeServerHealth;

  // Giriş: sunucu varsa online, yoksa yerel (offline) kariyer
  async function handleSmartLogin() {
    const username = (document.getElementById("loginUsername") || {}).value?.trim();
    const password = (document.getElementById("loginPassword") || {}).value;
    const errorEl = document.getElementById("loginError");
    if (!username) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı gerekli.";
      return;
    }
    // GÜVENLİK/UX: sunucu kontrolü (probeServerHealth) bazen (özellikle
    // Render ücretsiz planda "cold start" — servis uykuya dalmışsa ilk
    // isteği uyandırırken 30-50 sn sürebilir) uzun sürebiliyordu ve bu
    // sırada butona hiçbir görsel geri bildirim verilmiyordu; kullanıcıya
    // "tıkladım ama hiçbir şey olmuyor" hissi veriyordu. Artık buton hemen
    // devre dışı bırakılıp bir bekleme mesajı gösteriliyor.
    const loginBtnEl = document.getElementById("loginBtn");
    if (loginBtnEl) loginBtnEl.disabled = true;
    if (errorEl) errorEl.innerText = "Bağlantı kontrol ediliyor...";
    const slowHintTimer = setTimeout(() => {
      if (errorEl)
        errorEl.innerText =
          "Sunucu uyandırılıyor, bu biraz sürebilir (ilk istek)...";
    }, 4000);
    let online;
    try {
      online = await probeServerHealth();
    } finally {
      clearTimeout(slowHintTimer);
    }
    if (online) {
      try {
        return await handleServerLogin();
      } finally {
        if (loginBtnEl) loginBtnEl.disabled = false;
      }
    }
    if (loginBtnEl) loginBtnEl.disabled = false;
    // Offline fallback
    if (errorEl)
      errorEl.innerText =
        "Sunucu yok — yerel kariyer açılıyor (çok oyunculu kapalı).";
    try {
      if (typeof completeLogin === "function") completeLogin(username);
      else if (typeof window.completeLogin === "function")
        window.completeLogin(username);
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Yerel giriş başarısız.";
    }
  }
  async function handleSmartRegister() {
    const online = await probeServerHealth();
    if (online) return handleServerRegister();
    const username = (document.getElementById("regUsername") || {}).value?.trim();
    const errorEl = document.getElementById("registerError");
    if (!username) {
      if (errorEl) errorEl.innerText = "Kullanıcı adı gerekli.";
      return;
    }
    if (errorEl)
      errorEl.innerText =
        "Sunucu yok — yerel hesap açılıyor (çok oyunculu kapalı).";
    try {
      if (typeof completeLogin === "function") completeLogin(username);
    } catch (e) {
      if (errorEl) errorEl.innerText = e.message || "Yerel kayıt başarısız.";
    }
  }
  rewireButton("loginBtn", handleSmartLogin);
  rewireButton("registerBtn", handleSmartRegister);
  wireEnterSubmit(["loginUsername", "loginPassword"], handleSmartLogin);
  probeServerHealth();
  setInterval(function () {
    probeServerHealth();
  }, 60000);

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
    // Stripe yok — Destek Ol (bağış) + yönetici onayı modeli
    try {
      if (typeof window.goToPremium === "function") {
        window.goToPremium();
        if (typeof pushNotification === "function")
          pushNotification(
            "⭐",
            "Elite için Destek Ol ile katkı yap; yönetici onaylayınca aktif olur.",
            "Üyelik",
          );
        return;
      }
      const note = document.getElementById("premiumPayNote");
      if (note)
        note.innerText =
          "Elite: Destek Ol ile bağış bildir → yönetici onaylar. Plan: " +
          (plan || "monthly");
      if (typeof pushNotification === "function")
        pushNotification(
          "⭐",
          "Elite için Destek Ol panelini kullan.",
          "Üyelik",
        );
      else
        alert(
          "Elite için Destek Ol (bağış) kullan. Yönetici onaylayınca üyelik açılır.",
        );
    } catch (e) {
      alert("Elite için Destek Ol panelini açın.");
    }
    return;
    /* eski Stripe/checkout kodu — Destek Ol modeline geçildi */
    const note = document.getElementById("premiumPayNote");
    const isConnectivityError = (e) =>
      e instanceof TypeError ||
      /fetch|network|failed to fetch|NetworkError|Load failed/i.test(
        (e && e.message) || "",
      );
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
        let conf;
        try {
          conf = await apiFetch("/api/premium/confirm-mock", {
            method: "POST",
            body: JSON.stringify({ plan: plan }),
          });
        } catch (confErr) {
          if (isConnectivityError(confErr)) {
            if (typeof window.activatePremiumOffline === "function") {
              window.activatePremiumOffline(plan, { offlineNote: true });
            }
            return;
          }
          throw confErr;
        }
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
      // Sunucuya hiç ulaşılamıyorsa (offline/deploy sorunlu) kullanıcıyı
      // hata mesajıyla baş başa bırakmak yerine yerel/demo Elite'e düş —
      // böylece buton her koşulda gerçekten bir şey açar.
      if (isConnectivityError(e)) {
        if (typeof window.activatePremiumOffline === "function") {
          window.activatePremiumOffline(plan, { offlineNote: true });
          return;
        }
      }
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

  /** Sunucuda ikinci takım yoksa oluştur (Elite) */
  window.__emEnsureSecondTeamServer = async function (name) {
    try {
      const res = await apiFetch("/api/premium/second-team/ensure", {
        method: "POST",
        body: JSON.stringify(name ? { name: name } : {}),
      });
      if (res && res.secondTeam) {
        try {
          if (typeof secondTeamState !== "undefined") secondTeamState = res.secondTeam;
          window.secondTeamState = res.secondTeam;
        } catch (e) {
          window.secondTeamState = res.secondTeam;
        }
        try {
          if (typeof persistSecondTeam === "function") persistSecondTeam();
        } catch (e2) {}
        return res.secondTeam;
      }
      return null;
    } catch (e) {
      console.warn("[em] ensure second team", e);
      return null;
    }
  };

  window.__emSaveSecondTeamServer = async function (data) {
    try {
      if (!data || !data.name) return false;
      // Boş kadroyu sunucuya yazma
      const pl = (data.players || []).length + (data.bench || []).length;
      if (pl < 1) {
        console.warn("[em] second team empty skip");
        return false;
      }
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

  /** Elite 2. takımı sunucudan yükle → secondTeamState */
  window.__emLoadSecondTeamServer = async function () {
    try {
      const res = await apiFetch("/api/premium/second-team");
      if (!res || !res.secondTeam || !res.secondTeam.name) return null;
      const st = res.secondTeam;
      try {
        if (typeof secondTeamState !== "undefined") {
          secondTeamState = st;
        } else {
          window.secondTeamState = st;
        }
      } catch (e1) {
        window.secondTeamState = st;
      }
      try {
        if (typeof persistSecondTeam === "function") persistSecondTeam();
        else if (typeof secondTeamKey === "function") {
          localStorage.setItem(secondTeamKey(), JSON.stringify(st));
        }
      } catch (e2) {}
      try {
        if (typeof registerSecondTeamInLeague === "function")
          registerSecondTeamInLeague();
      } catch (e3) {}
      return st;
    } catch (e) {
      console.warn("[em] second team load", e);
      return null;
    }
  };

  /** Lig liderlik tablosu (çok oyunculu) */
  window.__emFetchLeagueRanking = async function (country, division) {
    try {
      let q = "/api/league/ranking?";
      if (country) q += "country=" + encodeURIComponent(country) + "&";
      if (division) q += "division=" + encodeURIComponent(division);
      return await apiFetch(q);
    } catch (e) {
      console.warn("[em] ranking", e);
      return null;
    }
  };

  window.__emClaimDailyRewardServer = async function (opts) {
    opts = opts || {};
    try {
      const res = await apiFetch("/api/premium/daily-reward", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (res && res.ok && res.balance != null) {
        try {
          if (typeof clubBudget !== "undefined") clubBudget = res.balance;
          if (typeof teamConfig !== "undefined" && teamConfig.home)
            teamConfig.home.budget = res.balance;
          if (typeof updateBudgetUI === "function") updateBudgetUI();
          if (typeof updateMenuBudget === "function") updateMenuBudget();
        } catch (e) {}
        if (opts.notify !== false && typeof pushNotification === "function") {
          pushNotification(
            "🎁",
            "Günlük ödül: +" +
              Number(res.amount || 0).toLocaleString("tr-TR") +
              " €",
            "Ödül",
          );
        }
      }
      return res;
    } catch (e) {
      if (
        e &&
        (e.code === "ALREADY_CLAIMED" ||
          (e.message || "").indexOf("zaten") >= 0)
      ) {
        return { ok: false, code: "ALREADY_CLAIMED" };
      }
      console.warn("[em] daily reward", e);
      if (opts.quiet) return { ok: false, error: e.message };
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

  // after login: kit + günlük ödül (bir kez/gün)
  try {
    const _al = afterServerLogin;
    afterServerLogin = async function (data) {
      await _al(data);
      try {
        await window.__emLoadSecondTeamServer();
      } catch (eSt) {}
      try {
        await window.__emLoadKitServer();
      } catch (e) {}
      try {
        if (typeof window.__emClaimDailyRewardServer === "function") {
          await window.__emClaimDailyRewardServer({ quiet: true });
        }
      } catch (e) {}
      try {
        if (typeof renderPremiumPage === "function") renderPremiumPage();
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

  window.adminFullWorldReset = async function () {
    if (!(window.__emServerAdmin || (typeof window.__emIsServerAdmin === "function" && window.__emIsServerAdmin()))) {
      try {
        if (typeof __emDetectAdmin === "function") await __emDetectAdmin();
      } catch (e) {}
    }
    if (!window.__emServerAdmin) {
      alert("Sadece admin bu işlemi yapabilir.");
      return;
    }
    const ok = confirm(
      "DÜNYAYI SIFIRLA\n\n" +
        "• Tüm lig puanları ve fikstürler silinir\n" +
        "• Tüm kulüplerin oyuncuları baştan üretilir\n" +
        "• Milli grup kuraları otomatik yeniden çekilir\n\n" +
        "Bu işlem GERİ ALINAMAZ. Devam edilsin mi?",
    );
    if (!ok) return;
    const ok2 = confirm("Son onay: Gerçekten tüm dünyayı sıfırlamak istiyor musun?");
    if (!ok2) return;
    const st = document.getElementById("adminFullResetStatus");
    if (st) st.innerHTML = '<span style="color:#fbbf24;">Sıfırlanıyor… lütfen bekleyin.</span>';
    try {
      const res = await apiFetch("/api/admin/full-reset", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      const sum = (res && res.summary) || {};
      if (st) {
        st.innerHTML =
          '<span style="color:#4ade80;">Tamam · kadro ' +
          (sum.squadsRegenerated || 0) +
          ", standings " +
          (sum.standingsReset || 0) +
          ", sezon " +
          (sum.seasonsTouched || 0) +
          "</span>";
      }
      alert(
        "Dünya sıfırlandı.\n" +
          "Kadro yenilenen kulüp: " +
          (sum.squadsRegenerated || 0) +
          "\nPuan sıfırlanan satır: " +
          (sum.standingsReset || 0) +
          "\nSezon: " +
          (sum.seasonsTouched || 0),
      );
      try {
        if (typeof window.__emRefreshTeam === "function") await window.__emRefreshTeam();
      } catch (e) {}
      try {
        if (typeof fetchNationalGroupsFromServer === "function")
          await fetchNationalGroupsFromServer(true);
      } catch (e) {}
      try {
        if (typeof loadLeagueFromServer === "function") await loadLeagueFromServer();
      } catch (e) {}
    } catch (err) {
      if (st)
        st.innerHTML =
          '<span style="color:#f87171;">Hata: ' +
          (err.message || err) +
          "</span>";
      alert(err.message || "Sıfırlama başarısız");
    }
  };


  window.__emAdminAuditRefresh = async function () {
    const el = document.getElementById("adminAuditLogs");
    if (!el) return;
    try {
      await __emDetectAdmin();
      if (!window.__emServerAdmin) {
        el.innerText = "Admin yetkisi yok.";
        return;
      }
      el.innerHTML = '<span style="color:#64748b;">Yükleniyor…</span>';
      const data = await apiFetch("/api/admin/audit-log?limit=60");
      const logs = (data && data.logs) || [];
      if (!logs.length) {
        el.innerHTML = '<span style="color:#64748b;">Kayıt yok.</span>';
        return;
      }
      const esc =
        typeof adminAcEscape === "function"
          ? adminAcEscape
          : function (s) {
              return String(s == null ? "" : s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;");
            };
      el.innerHTML = logs
        .map(function (L) {
          const when = L.created_at
            ? new Date(L.created_at).toLocaleString("tr-TR")
            : "";
          const admin = esc(L.admin_username || (L.admin_id || "?").toString().slice(0, 8));
          const action = esc(L.action || "?");
          const target = esc(L.target_label || L.target_user_id || "—");
          let det = "";
          try {
            det =
              L.details && typeof L.details === "object"
                ? JSON.stringify(L.details)
                : String(L.details || "");
          } catch (e) {
            det = "";
          }
          if (det.length > 120) det = det.slice(0, 120) + "…";
          det = esc(det);
          return (
            '<div style="padding:6px 4px;border-bottom:1px solid #1e293b;line-height:1.35;">' +
            '<div style="color:#64748b;">' +
            when +
            " · admin <b style=\"color:#e2e8f0;\">" +
            admin +
            "</b></div>" +
            '<div><code style="color:#fbbf24;">' +
            action +
            "</code> → <span style=\"color:#38bdf8;\">" +
            target +
            "</span></div>" +
            (det
              ? '<div style="color:#64748b;margin-top:2px;">' + det + "</div>"
              : "") +
            "</div>"
          );
        })
        .join("");
    } catch (e) {
      el.innerHTML =
        '<span style="color:#f87171;">Hata: ' +
        (e && e.message ? e.message : e) +
        "</span>";
    }
  };

  window.__emAdminAcRefresh = async function () {
    const sum = document.getElementById("adminAcSummary");
    const logsEl = document.getElementById("adminAcLogs");
    try {
      await __emDetectAdmin();
      if (!window.__emServerAdmin) {
        if (sum) sum.innerText = "Admin yetkisi yok.";
        const ac = document.getElementById("adminAntiCheatPanel");
        if (ac) ac.style.display = "none";
        const donHide = document.getElementById("adminDonationPanel");
        if (donHide) donHide.style.display = "none";
        return;
      }
      const ac = document.getElementById("adminAntiCheatPanel");
      if (ac) ac.style.display = "block";
      const donP = document.getElementById("adminDonationPanel");
      if (donP) donP.style.display = "block";
      try {
        if (typeof window.adminDonationsRefresh === "function")
          window.adminDonationsRefresh();
      } catch (eD) {}
      try {
        if (typeof window.__emAdminAuditRefresh === "function")
          window.__emAdminAuditRefresh();
      } catch (eA) {}
      try {
        if (typeof window.__emAdminMaintRefresh === "function")
          window.__emAdminMaintRefresh();
      } catch (eM) {}

      const [summary, logs, sec] = await Promise.all([
        apiFetch("/api/admin/anti-cheat/summary"),
        apiFetch("/api/admin/anti-cheat/logs?limit=40"),
        apiFetch("/api/admin/security-overview").catch(function () {
          return null;
        }),
      ]);

      if (sum) {
        const by = (summary && summary.last24h && summary.last24h.byAction) || [];
        const top = (summary && summary.last24h && summary.last24h.topUsers) || [];
        let html = "";
        if (sec && sec.ok) {
          const m = sec.maintenance || {};
          const locks = (sec.locks && sec.locks.count) || 0;
          const bans = (sec.bans && sec.bans.count) || 0;
          const pol = sec.loginPolicy || {};
          html +=
            '<div style="margin-bottom:10px;padding:8px;border-radius:8px;background:#020617;border:1px solid #334155;">' +
            '<div style="font-weight:700;color:#e2e8f0;margin-bottom:6px;">Güvenlik özeti</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:10px 16px;font-size:12px;">' +
            "<div>Bakım: " +
            (m.enabled
              ? '<span style="color:#fbbf24;">AÇIK</span> <span style="color:#64748b;">(' +
                (m.source || "?") +
                ")</span>"
              : '<span style="color:#4ade80;">kapalı</span>') +
            "</div>" +
            "<div>Kilitli: <b style=\"color:" +
            (locks ? "#fbbf24" : "#94a3b8") +
            ';\">' +
            locks +
            "</b></div>" +
            "<div>Banlı: <b style=\"color:" +
            (bans ? "#f87171" : "#94a3b8") +
            ';\">' +
            bans +
            "</b></div>" +
            '<div style="color:#64748b;">Politika: ' +
            (pol.maxFailures || 8) +
            " fail / " +
            (pol.lockMinutes || 15) +
            " dk</div>" +
            "</div></div>";
        }
        html +=
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

  window.__emAdminMaintRefresh = async function () {
    const el = document.getElementById("adminMaintStatus");
    try {
      const data = await apiFetch("/api/admin/maintenance");
      const on = !!(data && data.enabled);
      const src = (data && data.source) || "?";
      const msg = (data && data.message) || "";
      if (el) {
        el.innerHTML =
          (on
            ? '<span style="color:#fbbf24;">AÇIK</span>'
            : '<span style="color:#4ade80;">kapalı</span>') +
          " · kaynak: <code style=\"color:#38bdf8;\">" +
          src +
          "</code>" +
          (data && data.envForced
            ? ' <span style="color:#f87171;">(env zorunlu)</span>'
            : "") +
          (msg
            ? '<div style="margin-top:4px;color:#94a3b8;">' +
              (typeof adminAcEscape === "function"
                ? adminAcEscape(msg)
                : msg) +
              "</div>"
            : "");
      }
      const inp = document.getElementById("adminMaintMsg");
      if (inp && msg && !inp.value) inp.value = msg;
    } catch (e) {
      if (el) el.textContent = e.message || "Durum alınamadı";
    }
  };

  window.__emAdminAnnounceSend = async function () {
    const inp = document.getElementById("adminAnnounceMsg");
    const sel = document.getElementById("adminAnnounceLevel");
    const st = document.getElementById("adminAnnounceStatus");
    const message = inp && inp.value ? String(inp.value).trim() : "";
    const level = sel && sel.value ? sel.value : "info";
    if (!message || message.length < 2) {
      alert("Duyuru metni yaz.");
      return;
    }
    if (!confirm("Tüm çevrimiçi oyunculara gönderilsin mi?\n\n" + message)) return;
    try {
      if (st) st.textContent = "Gönderiliyor…";
      const data = await apiFetch("/api/admin/announce", {
        method: "POST",
        body: JSON.stringify({ message: message, level: level }),
      });
      if (st)
        st.textContent =
          "Gönderildi · alıcı socket ≈ " + (data.recipients != null ? data.recipients : "?");
      if (inp) inp.value = "";
    } catch (e) {
      if (st) st.textContent = e.message || "Hata";
      alert(e.message || "Duyuru gönderilemedi");
    }
  };

  window.__emAdminMaintSet = async function (enabled) {
    const el = document.getElementById("adminMaintStatus");
    const inp = document.getElementById("adminMaintMsg");
    const message = inp && inp.value ? String(inp.value).trim() : "";
    if (enabled) {
      if (
        !confirm(
          "Bakım modu AÇILSIN mı? Oyuncular API’ye erişemez (health hariç).",
        )
      )
        return;
    } else {
      if (!confirm("Bakım modu kapatılsın mı?")) return;
    }
    try {
      if (el) el.textContent = "Kaydediliyor…";
      const body = { enabled: !!enabled };
      if (message) body.message = message;
      const data = await apiFetch("/api/admin/maintenance", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (el) {
        el.innerHTML =
          (data && data.enabled
            ? '<span style="color:#fbbf24;">AÇIK</span>'
            : '<span style="color:#4ade80;">kapalı</span>') +
          " · kaydedildi";
      }
      if (typeof window.__emAdminMaintRefresh === "function")
        window.__emAdminMaintRefresh();
      // Kendi istemci bandını güncelle
      try {
        if (typeof window.__emSetMaintenance === "function") {
          window.__emSetMaintenance(
            !!(data && data.enabled),
            (data && data.message) || message || "",
          );
        }
      } catch (eM) {}
    } catch (e) {
      alert(e.message || "Bakım ayarlanamadı");
      if (el) el.textContent = e.message || "Hata";
    }
  };

  window.__emAdminAcOnlineUsers = async function () {
    const logsEl = document.getElementById("adminAcLogs");
    const box = document.getElementById("adminAcUserBox");
    try {
      const data = await apiFetch("/api/admin/online-users");
      const list = (data && data.users) || [];
      if (box) {
        box.innerHTML =
          '<span style="color:#2dd4bf;">Çevrimiçi: ' +
          (data.count || 0) +
          " kullanıcı · " +
          (data.socketCount || 0) +
          " socket</span>";
      }
      if (logsEl) {
        logsEl.innerHTML = list.length
          ? list
              .map(function (u) {
                const name =
                  typeof adminAcEscape === "function"
                    ? adminAcEscape(u.username || "#" + u.userId)
                    : u.username || u.userId;
                return (
                  '<div style="padding:8px 10px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
                  "<div><b style=\"color:#e2e8f0;\">" +
                  name +
                  '</b> <span style="color:#94a3b8;">#' +
                  String(u.userId).slice(0, 8) +
                  "</span>" +
                  '<div style="color:#64748b;font-size:11px;">socket × ' +
                  (u.sockets || 1) +
                  (u.clubId ? " · club " + String(u.clubId).slice(0, 8) : "") +
                  "</div></div>" +
                  '<button type="button" class="sub-btn" style="width:auto;padding:4px 10px;background:linear-gradient(90deg,#7c3aed,#a78bfa);font-size:11px;" onclick="(function(){var el=document.getElementById(\'adminBanUser\');if(el)el.value=\'' +
                  String(u.username || u.userId).replace(/'/g, "") +
                  '\';if(typeof window.__emAdminAcRevokeSessions===\'function\')window.__emAdminAcRevokeSessions();})()">Oturum düşür</button>' +
                  "</div>"
                );
              })
              .join("")
          : '<div style="padding:12px;color:#64748b;">Çevrimiçi authenticated kullanıcı yok.</div>';
      }
    } catch (e) {
      if (logsEl)
        logsEl.innerHTML =
          '<div style="padding:12px;color:#f87171;">' +
          (e.message || "Liste alınamadı") +
          "</div>";
    }
  };

  window.__emAdminAcRevokeSessions = async function () {
    const target = (document.getElementById("adminBanUser") || {}).value;
    if (!target || !String(target).trim()) {
      alert("Kullanıcı adı veya id gir.");
      return;
    }
    if (
      !confirm(
        "Tüm oturumları düşür: " +
          target +
          " ?\nKullanıcı tüm cihazlardan çıkış yapmış olur.",
      )
    )
      return;
    try {
      const res = await apiFetch("/api/admin/revoke-sessions", {
        method: "POST",
        body: JSON.stringify({ target: String(target).trim() }),
      });
      alert(res.message || ("Oturumlar iptal: " + (res.username || target)));
      if (typeof window.__emAdminAcLookup === "function")
        window.__emAdminAcLookup();
    } catch (e) {
      alert(e.message || "Oturum iptali başarısız");
    }
  };

  window.__emAdminAcUnlockLogin = async function () {
    const target = (document.getElementById("adminBanUser") || {}).value;
    if (!target || !String(target).trim()) {
      alert("Kullanıcı adı veya id gir.");
      return;
    }
    if (!confirm("Giriş kilidini aç: " + target + " ?")) return;
    try {
      const res = await apiFetch("/api/admin/unlock-login", {
        method: "POST",
        body: JSON.stringify({ target: String(target).trim() }),
      });
      alert(
        res.message ||
          ("Kilit açıldı: " + (res.username || target)),
      );
      if (typeof window.__emAdminAcLookup === "function")
        window.__emAdminAcLookup();
      if (typeof window.__emAdminAcRefresh === "function")
        window.__emAdminAcRefresh();
    } catch (e) {
      alert(e.message || "Kilit açma başarısız");
    }
  };

  window.__emAdminAcLocked = async function () {
    const logsEl = document.getElementById("adminAcLogs");
    const box = document.getElementById("adminAcUserBox");
    try {
      const data = await apiFetch("/api/admin/locked");
      const list = (data && (data.locked_users || data.users)) || [];
      if (box) {
        box.innerHTML =
          list.length === 0
            ? '<span style="color:#4ade80;">Şu an kilitli hesap yok.</span>'
            : '<span style="color:#fbbf24;">Kilitli hesap: ' +
              list.length +
              "</span>";
      }
      if (logsEl) {
        logsEl.innerHTML = list.length
          ? list
              .map(function (u) {
                const name =
                  typeof adminAcEscape === "function"
                    ? adminAcEscape(u.username || "#" + u.id)
                    : u.username || u.id;
                const until = u.locked_until
                  ? typeof adminAcEscape === "function"
                    ? adminAcEscape(String(u.locked_until))
                    : String(u.locked_until)
                  : "—";
                const fails = Number(u.failed_login_count || 0);
                return (
                  '<div style="padding:8px 10px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
                  "<div><b style=\"color:#e2e8f0;\">" +
                  name +
                  '</b> <span style="color:#94a3b8;">#' +
                  u.id +
                  "</span>" +
                  '<div style="color:#94a3b8;font-size:11px;">fail=' +
                  fails +
                  " · until " +
                  until +
                  "</div></div>" +
                  '<button type="button" class="sub-btn" style="width:auto;padding:4px 10px;background:linear-gradient(90deg,#0d9488,#14b8a6);font-size:11px;" onclick="(function(){var el=document.getElementById(\'adminBanUser\');if(el)el.value=\'' +
                  String(u.username || u.id).replace(/'/g, "") +
                  '\';if(typeof window.__emAdminAcUnlockLogin===\'function\')window.__emAdminAcUnlockLogin();})()">Kilit aç</button>' +
                  "</div>"
                );
              })
              .join("")
          : '<div style="padding:12px;color:#64748b;">Kilitli hesap yok.</div>';
      }
    } catch (e) {
      if (logsEl)
        logsEl.innerHTML =
          '<div style="padding:12px;color:#f87171;">' +
          (e.message || "Liste alınamadı") +
          "</div>";
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
        var lockBit = "";
        if (u.is_locked || (u.locked_until && new Date(u.locked_until) > new Date())) {
          lockBit =
            ' <span style="color:#fbbf24;">KİLİTLİ</span>' +
            (u.locked_until
              ? " <span style=\"color:#94a3b8;\">→ " +
                (typeof adminAcEscape === "function"
                  ? adminAcEscape(String(u.locked_until))
                  : String(u.locked_until)) +
                "</span>"
              : "");
        }
        var failBit =
          u.failed_login_count != null
            ? "<div>Başarısız giriş: " +
              Number(u.failed_login_count || 0) +
              "</div>"
            : "";
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
          lockBit +
          (u.ban_reason
            ? "<div>Sebep: " +
              (typeof adminAcEscape === "function"
                ? adminAcEscape(u.ban_reason)
                : u.ban_reason) +
              "</div>"
            : "") +
          failBit +
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


  // ---------- Bağış / Destek Ol paneli ----------
  window.__emRenderDonationPanel = async function () {
    const box = document.getElementById("premiumSupportBox");
    const formBox = document.getElementById("premiumDonationForm");
    const listBox = document.getElementById("premiumMyDonations");
    if (!box && !formBox) return;
    try {
      const data = await apiFetch("/api/premium/donation-methods");
      const methods = (data && data.methods) || {};
      const plans = (data && data.plans) || [];
      if (box) {
        let html =
          '<div style="padding:14px;background:linear-gradient(135deg,#1e293b,#0f172a);border:1px solid #f59e0b;border-radius:14px;">' +
          '<div style="font-weight:800;color:#fbbf24;margin-bottom:8px;">💝 Destek Ol — Bağış bilgileri</div>' +
          '<div style="font-size:12px;color:#cbd5e1;line-height:1.55;margin-bottom:10px;">' +
          escapeHtml(methods.note || "") +
          "</div>";
        if (methods.iban) {
          html +=
            '<div style="margin-bottom:8px;padding:10px;background:#020617;border-radius:10px;border:1px solid #334155;">' +
            '<div style="font-size:11px;color:#94a3b8;">IBAN</div>' +
            '<div style="font-weight:700;color:#e2e8f0;word-break:break-all;" id="donIbanText">' +
            escapeHtml(methods.iban) +
            "</div>" +
            (methods.ibanName
              ? '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">' +
                escapeHtml(methods.ibanName) +
                "</div>"
              : "") +
            '<button type="button" class="sub-btn" style="width:auto;padding:4px 10px;font-size:11px;margin-top:6px;" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById(\'donIbanText\').innerText)">Kopyala</button></div>';
        }
        if (methods.papara) {
          html +=
            '<div style="margin-bottom:8px;padding:10px;background:#020617;border-radius:10px;border:1px solid #334155;">' +
            '<div style="font-size:11px;color:#94a3b8;">Papara</div>' +
            '<div style="font-weight:700;color:#e2e8f0;" id="donPaparaText">' +
            escapeHtml(methods.papara) +
            "</div>" +
            (methods.paparaName
              ? '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">' +
                escapeHtml(methods.paparaName) +
                "</div>"
              : "") +
            '<button type="button" class="sub-btn" style="width:auto;padding:4px 10px;font-size:11px;margin-top:6px;" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.getElementById(\'donPaparaText\').innerText)">Kopyala</button></div>';
        }
        if (methods.other) {
          html +=
            '<div style="font-size:12px;color:#94a3b8;margin-top:6px;">' +
            escapeHtml(methods.other) +
            "</div>";
        }
        if (!methods.iban && !methods.papara && !methods.other) {
          html +=
            '<div style="font-size:12px;color:#f87171;">Yönetici henüz IBAN/Papara tanımlamadı. Ortam değişkenleri: DONATION_IBAN, DONATION_PAPARA</div>';
        }
        html +=
          '<div style="margin-top:10px;font-size:12px;color:#94a3b8;">Paketler: ' +
          plans
            .filter(function (p) {
              return p.id !== "trial";
            })
            .map(function (p) {
              return (
                "<b style=\"color:#e2e8f0;\">" +
                escapeHtml(p.title || p.id) +
                "</b> " +
                escapeHtml(p.label || "")
              );
            })
            .join(" · ") +
          "</div></div>";
        box.innerHTML = html;
      }
      if (formBox) {
        const planOpts = plans
          .filter(function (p) {
            return p.id !== "trial";
          })
          .map(function (p) {
            return (
              '<option value="' +
              escapeHtml(p.id) +
              '">' +
              escapeHtml(p.title) +
              " — " +
              escapeHtml(p.label) +
              "</option>"
            );
          })
          .join("");
        formBox.innerHTML =
          '<div style="padding:14px;background:#0f172a;border:1px solid #2c3a52;border-radius:14px;">' +
          '<div style="font-weight:800;color:#e2e8f0;margin-bottom:8px;">📝 Bağış bildir</div>' +
          '<div style="display:grid;gap:8px;">' +
          '<label style="font-size:11px;color:#94a3b8;">Plan<select id="donPlan" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#020617;color:#e2e8f0;border:1px solid #334155;">' +
          planOpts +
          "</select></label>" +
          '<label style="font-size:11px;color:#94a3b8;">Yöntem<select id="donMethod" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#020617;color:#e2e8f0;border:1px solid #334155;"><option value="iban">IBAN / Havale</option><option value="papara">Papara</option><option value="other">Diğer</option></select></label>' +
          '<label style="font-size:11px;color:#94a3b8;">Gönderen ad<select style="display:none"></select><input id="donPayerName" placeholder="Hesap / ad soyad" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#020617;color:#e2e8f0;border:1px solid #334155;"/></label>' +
          '<label style="font-size:11px;color:#94a3b8;">Dekont / referans no<input id="donRef" placeholder="İşlem no" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#020617;color:#e2e8f0;border:1px solid #334155;"/></label>' +
          '<label style="font-size:11px;color:#94a3b8;">Not (isteğe bağlı)<input id="donNote" placeholder="Kullanıcı adın vb." style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#020617;color:#e2e8f0;border:1px solid #334155;"/></label>' +
          '<button type="button" class="sub-btn" style="width:100%;padding:12px;font-weight:800;background:linear-gradient(90deg,#f59e0b,#d97706);" onclick="submitEliteDonation()">Bağışı bildir</button>' +
          '<div id="donFormNote" style="font-size:12px;color:#94a3b8;text-align:center;"></div></div></div>';
      }
      // list
      if (listBox) {
        const mine = await apiFetch("/api/premium/my-donations");
        const rows = (mine && mine.donations) || [];
        if (!rows.length) {
          listBox.innerHTML = "";
        } else {
          listBox.innerHTML =
            '<div class="youth-section-title">Bağışlarım</div>' +
            rows
              .map(function (d) {
                const stColor =
                  d.status === "approved"
                    ? "#4ade80"
                    : d.status === "pending"
                      ? "#fbbf24"
                      : "#f87171";
                const amt = ((d.amount_cents || 0) / 100).toFixed(0) + " ₺";
                return (
                  '<div style="padding:8px 10px;margin-bottom:6px;background:#0f172a;border:1px solid #2c3a52;border-radius:10px;font-size:12px;color:#e2e8f0;display:flex;justify-content:space-between;gap:8px;align-items:center;">' +
                  "<div><b>" +
                  escapeHtml(d.plan) +
                  "</b> · " +
                  amt +
                  ' · <span style="color:' +
                  stColor +
                  ';">' +
                  escapeHtml(d.status) +
                  "</span>" +
                  (d.reference_code
                    ? '<div style="font-size:11px;color:#64748b;">Ref: ' +
                      escapeHtml(d.reference_code) +
                      "</div>"
                    : "") +
                  "</div>" +
                  (d.status === "pending"
                    ? '<button type="button" class="sub-btn" style="width:auto;padding:4px 8px;font-size:11px;background:#7f1d1d;" onclick="cancelEliteDonation(' +
                      d.id +
                      ')">İptal</button>'
                    : "") +
                  "</div>"
                );
              })
              .join("");
        }
      }
    } catch (e) {
      if (box)
        box.innerHTML =
          '<div style="padding:12px;color:#f87171;font-size:12px;">Bağış paneli: ' +
          escapeHtml(e.message || String(e)) +
          "</div>";
    }
  };

  window.submitEliteDonation = async function () {
    const note = document.getElementById("donFormNote");
    try {
      const plan = (document.getElementById("donPlan") || {}).value;
      const method = (document.getElementById("donMethod") || {}).value;
      const payerName = (document.getElementById("donPayerName") || {}).value;
      const referenceCode = (document.getElementById("donRef") || {}).value;
      const dnote = (document.getElementById("donNote") || {}).value;
      if (note) note.innerText = "Gönderiliyor…";
      const res = await apiFetch("/api/premium/donate", {
        method: "POST",
        body: JSON.stringify({
          plan: plan,
          method: method,
          payerName: payerName,
          referenceCode: referenceCode,
          note: dnote,
        }),
      });
      if (note)
        note.innerText =
          (res && res.message) || "Bağış bildirildi — onay bekleniyor.";
      if (typeof pushNotification === "function")
        pushNotification("💝", "Bağış bildirimin alındı", "Elite");
      window.__emRenderDonationPanel();
    } catch (e) {
      if (note) note.innerText = e.message || "Hata";
    }
  };

  window.cancelEliteDonation = async function (id) {
    try {
      await apiFetch("/api/premium/donate/cancel", {
        method: "POST",
        body: JSON.stringify({ donationId: id }),
      });
      window.__emRenderDonationPanel();
    } catch (e) {
      alert(e.message || "İptal başarısız");
    }
  };



  // Online iken loadCareer yerel kadroyu ezmesin — ardından sunucudan çek
  (function hookLoadCareer() {
    function install() {
      if (typeof window.loadCareer !== "function") return false;
      if (window.loadCareer.__emServerHooked) return true;
      const _orig = window.loadCareer;
      window.loadCareer = function (username) {
        const r = _orig.apply(this, arguments);
        try {
          if (
            window.__emServerAuthoritative &&
            typeof window.syncAllFromServer === "function"
          ) {
            window.syncAllFromServer().catch(function () {});
          }
        } catch (e) {}
        return r;
      };
      window.loadCareer.__emServerHooked = true;
      return true;
    }
    if (!install()) {
      setTimeout(install, 300);
      setTimeout(install, 1500);
    }
  })();

  // Presence + kuyruk: periyodik match denemesi (karşı taraf beklerken)
  (function queuePresenceLoop() {
    let t = null;
    function tick() {
      try {
        if (!getToken() || !window.__emServerAuthoritative) return;
        apiFetch("/api/instant/presence", {
          method: "POST",
          body: JSON.stringify({}),
        }).catch(function () {});
        // Kuyruktaysa status kontrol (eşleşme socket ile de gelir)
        apiFetch("/api/instant/queue/status")
          .then(function (s) {
            if (s && s.inQueue) {
              return apiFetch("/api/instant/queue/join", {
                method: "POST",
                body: JSON.stringify({}),
              }).then(function (r) {
                if (r && r.matched && r.fixtureId) {
                  if (typeof window.__emWatchInstantMatch === "function")
                    window.__emWatchInstantMatch(r);
                  else if (typeof watchFixture === "function")
                    watchFixture(r.fixtureId);
                }
              });
            }
          })
          .catch(function () {});
      } catch (e) {}
    }
    function start() {
      if (t) clearInterval(t);
      t = setInterval(tick, 12000);
    }
    start();
    window.__emRestartPresenceLoop = start;
  })();

  // ============================================================
  // Bağlantısız küçük özellikler — kupa sıradaki maç, sezon ödülleri,
  // maç arşivi detay sayfası
  // ============================================================

  /** Kupa "sıradaki maç" — GET /api/cup/next */
  window.loadCupNextMatch = async function () {
    try {
      if (!getToken()) return null;
      const data = await apiFetch("/api/cup/next");
      window.__emCupNext = data && data.fixture ? data.fixture : null;
      return data;
    } catch (e) {
      window.__emCupNext = null;
      return null;
    }
  };

  /** Sezon ödülleri + krallıklar — GET /api/league/stats (awards dahil) */
  window.loadSeasonAwards = async function (country, division) {
    try {
      if (!getToken()) return null;
      const c =
        country ||
        (typeof USER_COUNTRY !== "undefined" ? USER_COUNTRY : "Türkiye");
      const d =
        division ||
        (typeof USER_DIVISION !== "undefined" ? USER_DIVISION : 1);
      const data = await apiFetch(
        "/api/league/stats?country=" +
          encodeURIComponent(c) +
          "&division=" +
          encodeURIComponent(d),
      );
      window.__emSeasonAwards = data;
      return data;
    } catch (e) {
      window.__emSeasonAwards = null;
      return null;
    }
  };

  /** Maç arşivi listesi — GET /api/matches/recent */
  window.loadMatchArchive = async function (limit) {
    try {
      if (!getToken()) return [];
      const data = await apiFetch(
        "/api/matches/recent" + (limit ? "?limit=" + limit : ""),
      );
      const list = (data && data.matches) || [];
      window.__emMatchArchive = list;
      return list;
    } catch (e) {
      window.__emMatchArchive = [];
      return [];
    }
  };

  /** Maç arşivi detay — GET /api/matches/:id */
  window.loadMatchArchiveDetail = async function (matchId) {
    try {
      if (!getToken() || !matchId) return null;
      const data = await apiFetch("/api/matches/" + encodeURIComponent(matchId));
      return data;
    } catch (e) {
      return null;
    }
  };

  /**
   * Kupa sıradaki maç bilgisini HTML olarak döndürür (UI'ye enjekte edilebilir).
   */
  window.renderCupNextMatchHTML = function (fixture) {
    const f = fixture || window.__emCupNext;
    if (!f) {
      return (
        '<div style="color:#64748b;font-size:12px;padding:8px;text-align:center;">' +
        "Sıradaki kupa maçı yok (elenmiş veya henüz eşleşme yapılmamış)." +
        "</div>"
      );
    }
    const home = escapeHtml(f.homeName || "?");
    const away = escapeHtml(f.awayName || "?");
    const round = escapeHtml(f.roundLabel || f.round || "");
    const status =
      f.status === "live"
        ? '<span style="color:#f87171;font-weight:700;">CANLI</span>'
        : '<span style="color:#38bdf8;">Planlandı</span>';
    let kick = "";
    if (f.kickoffAt) {
      try {
        const d = new Date(f.kickoffAt);
        kick =
          d.toLocaleString("tr-TR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }) || "";
      } catch (e) {}
    }
    return (
      '<div style="background:rgba(30,41,59,0.6);border:1px solid #334155;border-radius:8px;padding:10px 12px;margin:6px 0;">' +
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">🏆 Sıradaki Kupa Maçı' +
      (round ? " · " + round : "") +
      "</div>" +
      '<div style="font-size:14px;font-weight:700;color:#e2e8f0;">' +
      home +
      ' <span style="color:#64748b;">vs</span> ' +
      away +
      "</div>" +
      '<div style="font-size:12px;margin-top:4px;">' +
      status +
      (kick ? ' · <span style="color:#94a3b8;">' + kick + "</span>" : "") +
      "</div></div>"
    );
  };

  /**
   * Sezon ödülleri listesini HTML olarak döndürür.
   */
  window.renderSeasonAwardsHTML = function (data) {
    const d = data || window.__emSeasonAwards;
    if (!d) {
      return (
        '<div style="color:#64748b;font-size:12px;padding:8px;text-align:center;">Ödül verisi yüklenemedi.</div>'
      );
    }
    const awards = d.awards || [];
    const poty = d.playerOfYearPreview || [];
    const pom = d.playerOfMonth || [];
    let html =
      '<div class="youth-section-title">Sezon Ödülleri</div>';
    if (d.season && d.season.yearLabel) {
      html +=
        '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">Sezon: ' +
        escapeHtml(d.season.yearLabel) +
        (d.month
          ? " · Ay: " + d.month.year + "/" + String(d.month.month).padStart(2, "0")
          : "") +
        "</div>";
    }

    // Kaydedilmiş ödüller
    if (awards.length) {
      html +=
        '<div style="font-size:12px;font-weight:700;color:#facc15;margin:8px 0 4px;">🏆 Verilen Ödüller</div>';
      awards.slice(0, 12).forEach(function (a) {
        const typeMap = {
          goal_king: "Gol Kralı",
          assist_king: "Asist Kralı",
          player_of_year: "Yılın Oyuncusu",
          player_of_month: "Ayın Oyuncusu",
        };
        const label = typeMap[a.awardType] || a.awardType || "Ödül";
        html +=
          '<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid rgba(51,65,85,0.3);font-size:12px;">' +
          "<span>" +
          escapeHtml(label) +
          ": <b>" +
          escapeHtml(a.playerName || "?") +
          "</b> <span style=\"color:#64748b;\">(" +
          escapeHtml(a.clubName || "-") +
          ")</span></span>" +
          '<b style="color:#4ade80;">' +
          (a.value != null ? a.value : "") +
          "</b></div>";
      });
    }

    // Önizleme: Yılın oyuncusu adayları
    if (poty.length) {
      html +=
        '<div style="font-size:12px;font-weight:700;color:#facc15;margin:12px 0 4px;">⭐ Yılın Oyuncusu (önizleme)</div>';
      poty.slice(0, 8).forEach(function (s, i) {
        html +=
          '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;">' +
          "<span>" +
          (i + 1) +
          ". " +
          escapeHtml(s.playerName || "?") +
          ' <span style="color:#64748b;">(' +
          escapeHtml(s.clubName || "-") +
          ")</span></span>" +
          '<b style="color:#38bdf8;">' +
          (s.score != null ? s.score : (s.goals || 0) + "G " + (s.assists || 0) + "A") +
          "</b></div>";
      });
    }

    // Ayın oyuncusu panosu
    if (pom.length) {
      html +=
        '<div style="font-size:12px;font-weight:700;color:#facc15;margin:12px 0 4px;">📅 Ayın Oyuncusu panosu</div>';
      pom.slice(0, 8).forEach(function (s, i) {
        html +=
          '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;">' +
          "<span>" +
          (i + 1) +
          ". " +
          escapeHtml(s.playerName || "?") +
          ' <span style="color:#64748b;">(' +
          escapeHtml(s.clubName || "-") +
          ")</span></span>" +
          '<b style="color:#f472b6;">' +
          (s.score != null ? s.score : "") +
          "</b></div>";
      });
    }

    if (!awards.length && !poty.length && !pom.length) {
      html +=
        '<div style="color:#64748b;text-align:center;padding:10px;">Henüz ödül veya önizleme verisi yok.</div>';
    }
    return html;
  };

  /**
   * Maç arşivi listesi HTML.
   */
  window.renderMatchArchiveListHTML = function (list) {
    const matches = list || window.__emMatchArchive || [];
    if (!matches.length) {
      return (
        '<div style="color:#64748b;font-size:12px;padding:12px;text-align:center;">Arşivde maç yok.</div>'
      );
    }
    let html =
      '<div class="youth-section-title">Maç Arşivi</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">Son oynanan maçlar · tıkla detay</div>';
    matches.forEach(function (m) {
      const id = m.id;
      const home = escapeHtml(m.homeName || "?");
      const away = escapeHtml(m.awayName || "?");
      const score =
        (m.homeGoals != null ? m.homeGoals : "?") +
        " - " +
        (m.awayGoals != null ? m.awayGoals : "?");
      const comp = escapeHtml(m.competition || "");
      let when = "";
      if (m.finishedAt) {
        try {
          when = new Date(m.finishedAt).toLocaleString("tr-TR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
        } catch (e) {}
      }
      html +=
        '<div class="card-box" style="cursor:pointer;padding:8px 10px;margin:4px 0;border:1px solid #334155;border-radius:6px;" ' +
        'onclick="window.openMatchArchiveDetail && window.openMatchArchiveDetail(' +
        JSON.stringify(String(id)) +
        ')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        "<span>" +
        home +
        ' <b style="color:#facc15;">' +
        score +
        "</b> " +
        away +
        "</span>" +
        '<span style="font-size:11px;color:#64748b;">' +
        comp +
        (when ? " · " + when : "") +
        "</span></div></div>";
    });
    return html;
  };

  /**
   * Maç arşivi detay modalı açar.
   */
  window.openMatchArchiveDetail = async function (matchId) {
    const data = await window.loadMatchArchiveDetail(matchId);
    if (!data || !data.match) {
      if (typeof addLog === "function") addLog("Maç detayı alınamadı.");
      else alert("Maç detayı alınamadı.");
      return;
    }
    const m = data.match;
    const logs = data.logs || [];
    const home = escapeHtml(m.home_name || m.homeName || "?");
    const away = escapeHtml(m.away_name || m.awayName || "?");
    const hg = m.home_goals != null ? m.home_goals : m.homeGoals;
    const ag = m.away_goals != null ? m.away_goals : m.awayGoals;
    const score = (hg != null ? hg : "?") + " - " + (ag != null ? ag : "?");
    const comp = escapeHtml(m.competition || "");

    let eventsHtml = "";
    if (logs.length) {
      eventsHtml =
        '<div style="max-height:220px;overflow-y:auto;margin-top:10px;font-size:12px;">';
      logs.forEach(function (l) {
        eventsHtml +=
          '<div style="padding:2px 0;border-bottom:1px solid rgba(51,65,85,0.25);">' +
          '<span style="color:#64748b;min-width:36px;display:inline-block;">' +
          (l.minute != null ? l.minute + "'" : "") +
          "</span> " +
          escapeHtml(l.text || "") +
          "</div>";
      });
      eventsHtml += "</div>";
    } else {
      eventsHtml =
        '<div style="color:#64748b;font-size:12px;margin-top:8px;">Olay kaydı yok.</div>';
    }

    // Basit modal — mevcut modal altyapısı varsa onu kullan, yoksa alert benzeri
    let modal = document.getElementById("emMatchArchiveModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "emMatchArchiveModal";
      modal.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:16px;";
      document.body.appendChild(modal);
    }
    modal.innerHTML =
      '<div style="background:#0f172a;border:1px solid #334155;border-radius:12px;max-width:480px;width:100%;max-height:90vh;overflow:auto;padding:16px 18px;position:relative;">' +
      '<button type="button" style="position:absolute;top:10px;right:12px;background:transparent;border:none;color:#94a3b8;font-size:20px;cursor:pointer;" onclick="document.getElementById(\'emMatchArchiveModal\').style.display=\'none\'">×</button>' +
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Maç Arşivi Detayı · ' +
      comp +
      "</div>" +
      '<div style="font-size:18px;font-weight:800;color:#e2e8f0;text-align:center;margin:8px 0;">' +
      home +
      ' <span style="color:#facc15;">' +
      score +
      "</span> " +
      away +
      "</div>" +
      eventsHtml +
      "</div>";
    modal.style.display = "flex";
    modal.onclick = function (e) {
      if (e.target === modal) modal.style.display = "none";
    };
  };

  /** Kupa bracket — GET /api/cup/bracket */
  window.loadCupBracket = async function (country) {
    try {
      if (!getToken()) return null;
      const c =
        country ||
        (typeof USER_COUNTRY !== "undefined" ? USER_COUNTRY : "Türkiye");
      const data = await apiFetch(
        "/api/cup/bracket?country=" + encodeURIComponent(c),
      );
      window.__emCupBracket = data;
      return data;
    } catch (e) {
      window.__emCupBracket = null;
      return null;
    }
  };

  /**
   * Gerçek kupa bracket HTML.
   * bracket: [{ id, round, roundLabel, slot, homeName, awayName, homeGoals, awayGoals, status, ... }]
   * round: genelde 1=QF, 2=SF, 3=Final (veya roundLabel ile)
   */
  window.renderCupBracketHTML = function (data) {
    const edition = data && data.edition;
    const bracket = (data && data.bracket) || [];
    const myName =
      (typeof teamConfig !== "undefined" &&
        teamConfig.home &&
        teamConfig.home.name) ||
      "";
    const myId =
      window.__emMyClub && window.__emMyClub.id != null
        ? String(window.__emMyClub.id)
        : null;

    if (!edition && !bracket.length) {
      return (
        '<div class="youth-section-title">Kupa — Eleme Ağacı</div>' +
        '<div style="color:#64748b;font-size:12px;padding:12px;text-align:center;">' +
        "Bu ülke için aktif kupa yok. Yönetim panelinden veya kupa oluşturma ile başlatılabilir." +
        "</div>"
      );
    }

    // Turları grupla
    const byRound = {};
    bracket.forEach(function (f) {
      const key = f.round != null ? String(f.round) : f.roundLabel || "0";
      if (!byRound[key]) byRound[key] = [];
      byRound[key].push(f);
    });
    const roundKeys = Object.keys(byRound).sort(function (a, b) {
      return Number(a) - Number(b);
    });

    // round label tahmin
    function roundTitle(key, fixtures) {
      if (fixtures && fixtures[0] && fixtures[0].roundLabel)
        return fixtures[0].roundLabel;
      const n = fixtures ? fixtures.length : 0;
      if (n >= 4) return "Çeyrek Final";
      if (n === 2) return "Yarı Final";
      if (n === 1) return "Final";
      return "Tur " + key;
    }

    function isMe(f) {
      if (myId) {
        if (f.homeClubId != null && String(f.homeClubId) === myId) return true;
        if (f.awayClubId != null && String(f.awayClubId) === myId) return true;
      }
      if (myName) {
        if (f.homeName === myName || f.awayName === myName) return true;
      }
      return false;
    }

    function teamSpan(name, clubId) {
      const safe = escapeHtml(name || "TBD");
      const click =
        name && name !== "TBD"
          ? ' style="cursor:pointer;text-decoration:underline;" onclick="event.stopPropagation();openClubProfileByName(' +
            JSON.stringify(name) +
            ')"'
          : "";
      return "<span" + click + ">" + safe + "</span>";
    }

    function matchCard(f) {
      const home = f.homeName || "TBD";
      const away = f.awayName || "TBD";
      const played =
        f.status === "finished" ||
        (f.homeGoals != null && f.awayGoals != null);
      let scoreHtml;
      if (played) {
        const sc =
          (f.homeGoals != null ? f.homeGoals : "?") +
          "-" +
          (f.awayGoals != null ? f.awayGoals : "?");
        const pen = f.penalties ? " (p)" : "";
        scoreHtml =
          ' <b style="color:#facc15;cursor:pointer;text-decoration:underline;" title="Maç raporu" ' +
          "onclick='event.stopPropagation();openMatchReportByScore(" +
          JSON.stringify(home) +
          "," +
          JSON.stringify(away) +
          "," +
          JSON.stringify(sc) +
          ")'>" +
          sc +
          pen +
          "</b> ";
      } else if (f.status === "live") {
        scoreHtml =
          ' <b style="color:#f87171;">CANLI</b> <span style="color:#64748b;">vs</span> ';
      } else {
        scoreHtml = ' <span style="color:#64748b;">vs</span> ';
      }
      const meMark = isMe(f)
        ? '<span style="color:#4ade80;font-weight:700;">● </span>'
        : "";
      let statusLine = "";
      if (f.status === "scheduled" && f.kickoffAt) {
        try {
          statusLine =
            '<div style="font-size:10px;color:#94a3b8;margin-top:2px;">' +
            new Date(f.kickoffAt).toLocaleString("tr-TR", {
              day: "2-digit",
              month: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }) +
            "</div>";
        } catch (e) {}
      } else if (played) {
        statusLine =
          '<div style="font-size:10px;color:#64748b;margin-top:2px;">Oynandı</div>';
      } else if (f.status === "live") {
        statusLine =
          '<div style="font-size:10px;color:#f87171;margin-top:2px;">Canlı</div>';
      } else {
        statusLine =
          '<div style="font-size:10px;color:#38bdf8;margin-top:2px;">Bekliyor</div>';
      }
      return (
        '<div class="cup-bracket-match" style="margin-bottom:6px;">' +
        meMark +
        teamSpan(home, f.homeClubId) +
        scoreHtml +
        teamSpan(away, f.awayClubId) +
        statusLine +
        "</div>"
      );
    }

    let html =
      '<div class="youth-section-title">Kupa — Eleme Ağacı</div>';
    if (edition) {
      html +=
        '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">' +
        escapeHtml(edition.country || "") +
        (edition.year_label || edition.yearLabel
          ? " · " + escapeHtml(edition.year_label || edition.yearLabel)
          : "") +
        (edition.status ? " · " + escapeHtml(edition.status) : "") +
        "</div>";
    }
    html += '<div id="cupNextMatchBox" style="margin-bottom:10px;"></div>';
    html += '<div class="cup-bracket" style="display:flex;flex-wrap:wrap;gap:12px;">';
    roundKeys.forEach(function (key) {
      const fixtures = byRound[key].slice().sort(function (a, b) {
        return (a.slot || 0) - (b.slot || 0);
      });
      html +=
        '<div class="cup-bracket-col" style="flex:1;min-width:140px;">' +
        "<h4>" +
        escapeHtml(roundTitle(key, fixtures)) +
        "</h4>";
      fixtures.forEach(function (f) {
        html += matchCard(f);
      });
      html += "</div>";
    });
    html += "</div>";

    // Sıradaki maç kutusunu doldur (async)
    setTimeout(function () {
      const box = document.getElementById("cupNextMatchBox");
      if (!box) return;
      if (typeof window.loadCupNextMatch === "function") {
        window
          .loadCupNextMatch()
          .then(function (d) {
            if (typeof window.renderCupNextMatchHTML === "function") {
              box.innerHTML = window.renderCupNextMatchHTML(
                d && d.fixture,
              );
            }
          })
          .catch(function () {
            box.innerHTML = "";
          });
      }
    }, 0);

    return html;
  };

  /**
   * Kupa fikstür listesi (düz liste) — bracket verisinden.
   */
  window.renderCupFixtureListHTML = function (data) {
    const bracket = (data && data.bracket) || [];
    if (!bracket.length) {
      return (
        '<div class="youth-section-title">Kupa — Fikstür</div>' +
        '<div style="color:#64748b;font-size:12px;padding:10px;text-align:center;">Fikstür yok.</div>'
      );
    }
    const myName =
      (typeof teamConfig !== "undefined" &&
        teamConfig.home &&
        teamConfig.home.name) ||
      "";
    let html =
      '<div class="youth-section-title">Kupa — Eleme Fikstürü</div>' +
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:8px;">Takım / skor tıklanabilir</div>';
    const byRound = {};
    bracket.forEach(function (f) {
      const key = f.round != null ? String(f.round) : f.roundLabel || "0";
      if (!byRound[key]) byRound[key] = [];
      byRound[key].push(f);
    });
    Object.keys(byRound)
      .sort(function (a, b) {
        return Number(a) - Number(b);
      })
      .forEach(function (key) {
        const fixtures = byRound[key];
        const label =
          (fixtures[0] && fixtures[0].roundLabel) || "Tur " + key;
        html +=
          '<div style="font-size:12px;font-weight:700;color:#facc15;margin:10px 0 4px;">' +
          escapeHtml(label) +
          "</div>";
        fixtures
          .slice()
          .sort(function (a, b) {
            return (a.slot || 0) - (b.slot || 0);
          })
          .forEach(function (f) {
            const home = f.homeName || "TBD";
            const away = f.awayName || "TBD";
            const me = home === myName || away === myName;
            const played =
              f.status === "finished" ||
              (f.homeGoals != null && f.awayGoals != null);
            let scoreHtml;
            if (played) {
              const sc =
                (f.homeGoals != null ? f.homeGoals : "?") +
                "-" +
                (f.awayGoals != null ? f.awayGoals : "?");
              scoreHtml =
                ' <b style="color:#facc15;cursor:pointer;text-decoration:underline;" onclick="event.stopPropagation();openMatchReportByScore(' +
                JSON.stringify(home) +
                "," +
                JSON.stringify(away) +
                "," +
                JSON.stringify(sc) +
                ')">' +
                sc +
                "</b> ";
            } else {
              scoreHtml = ' <span style="color:#64748b;">vs</span> ';
            }
            html +=
              '<div style="padding:6px 8px;margin:3px 0;border:1px solid #334155;border-radius:6px;font-size:13px;">' +
              (me
                ? '<span style="color:#4ade80;font-weight:700;">● </span>'
                : "") +
              '<span style="color:#60a5fa;cursor:pointer;text-decoration:underline;" onclick="openClubProfileByName(' +
              JSON.stringify(home) +
              ')">' +
              escapeHtml(home) +
              "</span>" +
              scoreHtml +
              '<span style="color:#f87171;cursor:pointer;text-decoration:underline;" onclick="openClubProfileByName(' +
              JSON.stringify(away) +
              ')">' +
              escapeHtml(away) +
              "</span>" +
              (played
                ? ' <span style="color:#64748b;font-size:11px;">(Oynandı)</span>'
                : ' <span style="color:#38bdf8;font-size:11px;">(Bekliyor)</span>') +
              "</div>";
          });
      });
    return html;
  };

  // Senkron sırasında kupa sıradaki maçı da çek
  const _origSyncAll = window.syncAllFromServer;
  if (typeof _origSyncAll === "function") {
    window.syncAllFromServer = async function () {
      const r = await _origSyncAll.apply(this, arguments);
      try {
        await window.loadCupNextMatch();
      } catch (e) {}
      return r;
    };
  }
})();
