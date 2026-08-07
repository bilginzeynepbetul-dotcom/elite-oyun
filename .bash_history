    .team-player-row .quality { font-weight: 700; width: 35px; text-align: right; }
    .trophy-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(51,65,85,0.2);
      font-size: 13px;
      color: #cbd5e1;
    }
    .trophy-item .trophy-icon { font-size: 20px; }
    .trophy-item .trophy-name { flex: 1; }
    .trophy-item .trophy-year { color: #94a3b8; font-size: 12px; }
    .fixture-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 0;
      font-size: 12.5px;
      color: #cbd5e1;
      border-bottom: 1px solid rgba(51,65,85,0.2);
    }
    .fixture-item .fixture-home { color: #60a5fa; text-align: left; flex: 1; }
    .fixture-item .fixture-away { color: #f87171; text-align: right; flex: 1; }
    .fixture-item .fixture-score { font-weight: 700; color: #facc15; padding: 0 10px; }
    .fixture-item .fixture-vs { color: #64748b; padding: 0 8px; font-size: 11px; }
    .quality-tag {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      margin-left: 6px;
    }
    .quality-tag.high { background: #4ade80; color: #052e16; }
    .quality-tag.mid { background: #facc15; color: #052e16; }
    .quality-tag.low { background: #f87171; color: #4c0519; }

    /* ==========================================
       GİRİŞ EKRANI STİLLERİ
       ========================================== */
    .login-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.85);
      backdrop-filter: blur(8px);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 99999;
      transition: opacity 0.5s ease;
    }
    .login-overlay.hidden { opacity: 0; pointer-events: none; }
    .login-box {
      background: linear-gradient(160deg, #1e293b, #0f172a);
      border: 1px solid #2c3a52;
      border-radius: 20px;
      padding: 40px 35px;
      max-width: 420px;
      width: 90%;
      text-align: center;
      box-shadow: 0 30px 80px rgba(0,0,0,0.8);
    }
    .login-box h1 {
      font-size: 28px;
      font-weight: 800;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      margin-bottom: 6px;
    }
    .login-box .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .login-box input {
      width: 100%;
      padding: 12px 16px;
      margin-bottom: 12px;
      border-radius: 10px;
      border: 1px solid #2c3a52;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 14px;
      transition: border 0.3s ease;
    }
    .login-box input:focus { outline: none; border-color: #38bdf8; }
    .login-box .login-btn {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 10px;
      background: linear-gradient(90deg, #38bdf8, #6366f1);
      color: #05203a;
      font-weight: 800;
      font-size: 16px;
      cursor: pointer;
      transition: transform 0.15s ease;
    }
    .login-box .login-btn:hover { transform: scale(1.02); }
    .login-box .login-btn:disabled { background: #334155; color: #94a3b8; cursor: not-allowed; }
    .login-box .error-msg { color: #f87171; font-size: 13px; margin-top: 8px; min-height: 20px; }
    .login-box .register-link { color: #94a3b8; font-size: 13px; margin-top: 16px; }
    .login-box .register-link span { color: #38bdf8; cursor: pointer; font-weight: 600; }
    .login-box .register-link span:hover { text-decoration: underline; }

    .register-form { display: none; }
    .register-form.active { display: block; }
    .login-form.hidden { display: none; }

    /* ==========================================
       ANA MENÜ STİLLERİ
       ========================================== */
    .main-menu-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: radial-gradient(circle at 50% 0%, #16213a 0%, #0a0f1e 55%, #060911 100%);
      z-index: 99998;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow-y: auto;
      padding: 20px;
    }
    .main-menu-overlay.hidden { display: none; }
    .main-menu-container {
      max-width: 500px;
      width: 100%;
      background: linear-gradient(160deg, #1e293b, #0f172a);
      border: 1px solid #2c3a52;
      border-radius: 20px;
      padding: 25px 20px;
      box-shadow: 0 30px 80px rgba(0,0,0,0.8);
      max-height: 95vh;
      overflow-y: auto;
    }
    .main-menu-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #2c3a52;
    }
    .main-menu-header h1 {
      font-size: 24px;
      font-weight: 800;
      background: linear-gradient(90deg, #38bdf8, #818cf8);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
    .main-menu-header .user-badge {
      font-size: 12px;
      color: #4ade80;
      background: #064e3b;
      padding: 4px 12px;
      border-radius: 12px;
      font-weight: 600;
    }
    .main-menu-user {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      padding: 10px 14px;
      background: #0f172a;
      border-radius: 12px;
      border: 1px solid #2c3a52;
    }
    .main-menu-user .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(90deg, #38bdf8, #6366f1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 18px;
      color: #0f172a;
    }
    .main-menu-user .info .name { font-weight: 700; color: #e2e8f0; font-size: 16px; }
    .main-menu-user .info .rank { font-size: 12px; color: #94a3b8; }
    .main-menu-user .info .rank span { color: #facc15; font-weight: 700; }

    .announcements {
      background: #0f172a;
      border-radius: 12px;
      padding: 12px 14px;
      margin-bottom: 16px;
      border: 1px solid #2c3a52;
    }
    .announcements .title {
      font-size: 12px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .announcement-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(51,65,85,0.3);
      font-size: 13px;
      color: #cbd5e1;
    }
    .announcement-item:last-child { border-bottom: none; }
    .announcement-item .icon { font-size: 16px; }
    .announcement-item .text { flex: 1; }
    .announcement-item .time { font-size: 10px; color: #64748b; white-space: nowrap; }

    .menu-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 10px;
      margin-top: 4px;
    }
    .menu-item {
      background: #0f172a;
      border: 1px solid #2c3a52;
      border-radius: 12px;
      padding: 14px 8px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
      color: #cbd5e1;
    }
    .menu-item:hover { background: #1e293b; border-color: #38bdf8; transform: translateY(-2px); }
    .menu-item .icon { font-size: 28px; display: block; margin-bottom: 4px; }
    .menu-item .label { font-size: 11px; font-weight: 600; }

    .logout-btn {
      width: 100%;
      padding: 10px;
      margin-top: 14px;
      border: none;
      border-radius: 10px;
      background: #1e293b;
      color: #f87171;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 1px solid #2c3a52;
    }
    .logout-btn:hover { background: #4c0519; border-color: #f87171; }

    @media (max-width: 640px) {
      body { padding: 10px; }
      .report-container, #report-container, #prematch-actions, #ratings-panel { width: 100%; }
      .formation-pitch-wrap { width: 100%; }
      .tactics-columns, .subs-columns { grid-template-columns: 1fr; }
      .menu-grid { grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
      .menu-item .icon { font-size: 22px; }
      .menu-item .label { font-size: 10px; }
      .main-menu-container { padding: 16px 12px; }
      .modal-content { padding: 18px 16px; }
      .login-box { padding: 30px 20px; }
    }
  </style>
</head>
<body>

  < ===== GERİ OK BUTONU ===== -->  <div class="back-arrow" id="backArrow" onclick="handleBackArrow()">◀</div>

  < ===== GİRİŞ EKRANI ===== -->  <div class="login-overlay" id="loginOverlay">
    <div class="login-box">
      <div class="login-form" id="loginForm">
        <h1>⚽ Elite Manager</h1>
        <p class="subtitle">Çok Oyunculu Futbol Simülasyonu</p>
        <input type="text" id="loginUsername" placeholder="Kullanıcı Adı" maxlength="20" value="admin">
        <input type="password" id="loginPassword" placeholder="Şifre" value="123456">
        <button class="login-btn" id="loginBtn">Giriş Yap</button>
        <div class="error-msg" id="loginError"></div>
        <div class="register-link">Hesabın yok mu? <span id="showRegister">Kayıt Ol</span></div>
      </div>
      <div class="register-form" id="registerForm">
        <h1>⚽ Elite Manager</h1>
        <p class="subtitle">Yeni Hesap Oluştur</p>
        <input type="text" id="regUsername" placeholder="Kullanıcı Adı" maxlength="20" value="admin">
        <input type="email" id="regEmail" placeholder="E-posta" value="admin@test.com">
        <input type="password" id="regPassword" placeholder="Şifre (en az 6 karakter)" value="123456">
        <button class="login-btn" id="registerBtn">Kayıt Ol</button>
        <div class="error-msg" id="registerError"></div>
        <div class="register-link">Zaten hesabın var mı? <span id="showLogin">Giriş Yap</span></div>
      </div>
    </div>
  </div>

  < ===== ANA MENÜ ===== -->  <div class="main-menu-overlay hidden" id="mainMenu">
    <div class="main-menu-container">
      <div class="main-menu-header">
        <h1>⚽ Elite Manager</h1>
        <span class="user-badge" id="menuUserBadge">🟢 Çevrimiçi</span>
      </div>
      <div class="main-menu-user">
        <div class="avatar" id="menuAvatar">A</div>
        <div class="info">
          <div class="name" id="menuUsername">admin</div>
          <div class="rank">🏆 Sıralama: <span id="menuRank">1200</span> · ⚽ <span id="menuMatches">0</span> maç</div>
        </div>
      </div>
      <div class="announcements">
        <div class="title">📢 Duyurular</div>
        <div id="announcementList">
          <div class="announcement-item"><span class="icon">🎉</span><span class="text">Hoş geldin! Oyuncu gelişim sistemi aktif!</span><span class="time">Şimdi</span></div>
          <div class="announcement-item"><span class="icon">⚡</span><span class="text">Yeni sezon başladı! Lig mücadelesi başlasın!</span><span class="time">Bugün</span></div>
          <div class="announcement-item"><span class="icon">📈</span><span class="text">Potansiyeli yüksek oyuncular daha hızlı gelişir</span><span class="time">1 gün</span></div>
        </div>
      </div>
      <div class="menu-grid">
        <div class="menu-item" onclick="goToMatch()"><span class="icon">⚽</span><span class="label">Maç</span></div>
        <div class="menu-item" onclick="goToTactics()"><span class="icon">📋</span><span class="label">Taktikler</span></div>
        <div class="menu-item" onclick="goToSubs()"><span class="icon">🔄</span><span class="label">Kadro</span></div>
        <div class="menu-item" onclick="goToLeagues()"><span class="icon">🏆</span><span class="label">Ligler</span></div>
        <div class="menu-item" onclick="goToProfile()"><span class="icon">👤</span><span class="label">Profil</span></div>
        <div class="menu-item" onclick="logoutUser()"><span class="icon">🚪</span><span class="label">Çıkış</span></div>
      </div>
    </div>
  </div>

  < ===== SAYFA 1: MAÇ ===== -->  <div id="page-match" class="page active">
    <div class="field-wrapper">
      <canvas id="field" width="600" height="400"></canvas>
    </div>

    <div id="report-container" class="report-container">
      <div class="score-board" id="scoreBoard" onclick="openUserTeamProfile('home')">00:00 - Murat SK 0 - 0 IDC Sinop</div>
      <div class="user-info">👤 Hoş geldin, <span class="username" id="usernameDisplay">Misafir</span></div>
      <div id="weatherNote" class="weather-note">Hava Durumu: -</div>
      <div id="stats-panel">
        <div class="stat-row"><span class="stat-val" id="homeShots">0</span><span class="stat-label">Şut</span><span class="stat-val" id="awayShots">0</span></div>
        <div class="stat-row"><span class="stat-val" id="homeOnTarget">0</span><span class="stat-label">İsabetli Şut</span><span class="stat-val" id="awayOnTarget">0</span></div>
        <div class="stat-row"><span class="stat-val" id="homeGoals">0</span><span class="stat-label">Gol</span><span class="stat-val" id="awayGoals">0</span></div>
        <div class="stat-row possession-row"><span class="stat-val" id="homePossession">50%</span><span class="stat-label">Top Hakimiyeti</span><span class="stat-val" id="awayPossession">50%</span></div>
        <div class="possession-bar"><div class="possession-fill" id="possessionFill"></div></div>
      </div>
      <div id="logs"><div id="logContent"></div></div>
    </div>

    <div id="prematch-actions">
      <div class="match-status" id="matchStatus">⏳ Maç başlamak için geri sayım: <span id="countdownDisplay">10</span> saniye</div>
      <div class="match-timer" id="matchTimerDisplay"></div>
      <div id="prematch-note">Taktikleri ve oyuncu değişikliklerini maç başlamadan önce ayarlayın. Maç otomatik olarak başlayacaktır.</div>
    </div>

    <div id="ratings-panel">
      <div class="tactics-title">Maç Sonu Oyuncu Değerlendirmeleri</div>
      <div class="ratings-columns">
        <div><div class="tactics-col-header home" id="homeRatingsLabel" onclick="openUserTeamProfile('home')">Murat SK</div><div id="homeRatingsList"></div></div>
        <div><div class="tactics-col-header away" id="awayRatingsLabel" onclick="openTeamProfileLight('away')">Deplasman</div><div id="awayRatingsList"></div></div>
      </div>
    </div>
  </div>

  < ===== SAYFA 2: KADRO ===== -->  <div id="page-squad" class="page">
    <div class="report-container">
      <div class="tactics-title">Oyuncu Değişiklikleri (Takım Başına Maks. 5)</div>
      <div id="subs-panel-inner">
        <div class="subs-columns">
          <div class="subs-col"><div class="tactics-col-header home" id="homeSubsLabel" onclick="openUserTeamProfile('home')">Murat SK (<span id="homeSubsLeft">5</span> hakkı)</div><select id="homeOutSelect"></select><select id="homeInSelect"></select><button id="homeSubBtn" class="sub-btn">Değişikliği Yap</button></div>
          <div class="subs-col"><div class="tactics-col-header away" id="awaySubsLabel" onclick="openTeamProfileLight('away')">Deplasman (<span id="awaySubsLeft">5</span> hakkı)</div><select id="awayOutSelect"></select><select id="awayInSelect"></select><button id="awaySubBtn" class="sub-btn">Değişikliği Yap</button></div>
        </div>
      </div>

      <div class="reports-title">Altyapı — Rastgele Oyuncu Çek</div>
      <div class="tactics-columns">
        <div>
          <div class="tactics-col-header home" onclick="openUserTeamProfile('home')">Murat SK Altyapısı</div>
          <div class="youth-info">
            <div class="youth-draw-area">
              <span>Kalan Oyuncu: <span class="youth-count" id="homeYouthCount">12</span></span>
              <button id="homeYouthDrawBtn" class="youth-btn">🎲 Oyuncu Çek</button>
            </div>
          </div>
          <div class="youth-section-title">📋 Kadroya Katılanlar</div>
          <div id="homeYouthRoster"></div>
        </div>
        <div>
          <div class="tactics-col-header away" onclick="openTeamProfileLight('away')">Deplasman Altyapısı</div>
          <div class="youth-info">
            <div class="youth-draw-area">
              <span>Kalan Oyuncu: <span class="youth-count" id="awayYouthCount">12</span></span>
              <button id="awayYouthDrawBtn" class="youth-btn">🎲 Oyuncu Çek</button>
            </div>
          </div>
          <div class="youth-section-title">📋 Kadroya Katılanlar</div>
          <div id="awayYouthRoster"></div>
        </div>
      </div>
    </div>
  </div>

  < ===== SAYFA 3: TAKTİK ===== -->  <div id="page-tactics" class="page">
    <div class="report-container">
      <div class="tactics-title">Diziliş — Sürükle-Bırak ile Mevki / Oyuncu Değişikliği</div>
      <div style="display:flex; justify-content:center; gap:6px; margin-bottom:10px;">
        <button class="side-toggle-btn active" id="tacticsSideHomeBtn" onclick="setFormationSide('home')">Murat SK</button>
        <button class="side-toggle-btn" id="tacticsSideAwayBtn" onclick="setFormationSide('away')">Deplasman</button>
      </div>
      <div class="formation-hint">Oyuncuyu sahada başka bir noktaya sürükleyerek mevki değiştirin, yedek oyuncuyu sahaya sürükleyerek değişiklik yapın.</div>
      <div class="formation-pitch-wrap" id="formationPitch"></div>
      <div class="formation-bench-list" id="formationBenchList"></div>
      <div class="subs-settings-row">
        <span>Takım Başına Değişiklik Hakkı:</span>
        <input type="number" id="subsMaxInput" min="1" max="11" value="5">
        <button class="sub-btn" id="subsMaxApplyBtn" style="width:auto;padding:6px 12px;">Uygula</button>
      </div>

      <div class="tactics-title" style="margin-top:18px;">Gelişmiş Taktikler (ÖGT)</div>
      <div class="tactics-columns">
        <div><div class="tactics-col-header home" id="homeTeamLabel" onclick="openUserTeamProfile('home')">Murat SK</div><div id="homeTacticsList"></div></div>
        <div><div class="tactics-col-header away" id="awayTeamLabel" onclick="openTeamProfileLight('away')">IDC Sinop</div><div id="awayTacticsList"></div></div>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2c3a52;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Pas Stili</div><select id="passStyleSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"><option value="kisa">Kısa Pas</option><option value="uzun">Uzun Pas</option><option value="hizli">Hızlı Pas</option></select></div>
          <div><div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Oyun Stili</div><select id="gameStyleSelect" style="width:100%;padding:6px 8px;border-radius:8px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;font-size:12px;"><option value="normal">Normal</option><option value="hücumsel">Hücum</option><option value="defansif">Defans</option></select></div>
        </div>
      </div>
    </div>
  </div>

  < ===== SAYFA 4: LİGLER ===== -->  <div id="page-leagues" class="page">
    <div class="report-container">
      <div class="tactics-title">Dünya Ligleri — 32 Ülke × 3 Lig × 10 Takım</div>
      <div class="league-controls"><select id="leagueCountrySelect"></select><select id="leagueDivisionSelect"><option value="1">1. Lig</option><option value="2">2. Lig</option><option value="3">3. Lig</option></select><button id="playRoundBtn" class="sub-btn">Haftayı Oynat</button></div>
      <div id="leagueScheduleNote" class="league-schedule-note"></div>
      <table class="standings-table"><thead><tr><th>#</th><th>Takım</th><th>O</th><th>G</th><th>B</th><th>M</th><th>Av</th><th>Puan</th></tr></thead><tbody id="standingsBody"></tbody></table>
      <div class="reports-title">Maç Raporları (Son Hafta)</div><div id="reportsList"></div>
    </div>
  </div>

  < ===== OYUNCU PROFİLİ MODAL ===== -->  <div class="modal-overlay" id="playerModal">
    <div class="modal-content">
      <button class="modal-close" id="modalCloseBtn">&times;</button>
      <div class="modal-title" id="modalPlayerName">Oyuncu Adı</div>
      <div class="modal-subtitle" id="modalPlayerSub">#99 · ST · 25 yaş</div>
      <div class="modal-section-title">📊 Maç Performansı</div>
      <div class="modal-stats" id="modalMatchStats">
        <div class="modal-stat"><span class="label">Değerlendirme</span><span class="value" id="mRating">6.0</span></div>
        <div class="modal-stat"><span class="label">Gol</span><span class="value" id="mGoals">0</span></div>
        <div class="modal-stat"><span class="label">Asist</span><span class="value" id="mAssists">0</span></div>
        <div class="modal-stat"><span class="label">Kurtarış</span><span class="value" id="mSaves">0</span></div>
        <div class="modal-stat"><span class="label">Kondisyon</span><span class="value" id="mCondition">90%</span></div>
        <div class="modal-stat"><span class="label">Form</span><span class="value" id="mForm">0.0</span></div>
      </div>
      <div class="modal-section-title">⚡ Yetenekler</div><div id="modalSkills"></div>
      <div class="modal-section-title">📋 Diğer Bilgiler</div>
      <div class="modal-stats" id="modalOtherStats">
        <div class="modal-stat"><span class="label">Tecrübe</span><span class="value" id="mExperience">5</span></div>
        <div class="modal-stat"><span class="label">Mutluluk</span><span class="value" id="mHappiness">80%</span></div>
        <div class="modal-stat"><span class="label">Doğal Mevki</span><span class="value" id="mNaturalPos">ST</span></div>
        <div class="modal-stat"><span class="label">Kart Durumu</span><span class="value" id="mCards">Yok</span></div>
        <div class="modal-stat"><span class="label">Kalite</span><span class="value" id="mQuality">-</span></div>
        <div class="modal-stat"><span class="label">Potansiyel</span><span class="value" id="mPotential">-</span></div>
        <div class="modal-stat"><span class="label">Yaş</span><span class="value" id="mAge">25</span></div>
      </div>
    </div>
  </div>

  < ===== TAKIM PROFİLİ MODAL ===== -->  <div class="team-modal-overlay" id="teamModal">
    <div class="team-modal-content">
      <button class="modal-close" id="teamModalCloseBtn">&times;</button>
      <div class="modal-title" id="teamModalName">Takım Adı</div>
      <div class="modal-subtitle" id="teamModalSub">Ülke · Lig</div>
      <div class="team-modal-tabs" id="teamModalTabs">
        <button class="team-modal-tab active" data-teamtab="team-squad">👥 Kadro</button>
        <button class="team-modal-tab" data-teamtab="team-fixture">📅 Fikstür</button>
        <button class="team-modal-tab" data-teamtab="team-trophies">🏆 Kupalar</button>
      </div>
      <div id="team-squad" class="team-modal-tab-content active"><div id="teamSquadList"></div></div>
      <div id="team-fixture" class="team-modal-tab-content"><div id="teamFixtureList"></div></div>
      <div id="team-trophies" class="team-modal-tab-content"><div id="teamTrophiesList"></div></div>
    </div>
  </div>

  < ===== SES KONTROL BUTONU ===== -->  <div class="sound-toggle" id="soundToggle" onclick="toggleSound()">🔊</div>

  < ===== JAVASCRIPT DOSYALARI ===== -->  <script src="/socket.io/socket.io.js"></script>
  <script src="game-engine.js"></script>
  <script src="ui-controller.js"></script>

</body>
</html>
```
cd ~/elite-manager/public/
touch index.html
touch game-engine.js
touch ui-controller.js
cat > index.html
