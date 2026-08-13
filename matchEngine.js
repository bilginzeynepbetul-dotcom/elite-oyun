// ============================================================
// matchEngine.js — SUNUCU TARAFLI OTORİTER MAÇ MOTORU
// Hızlı (arka plan) veya canlı tick destekler.
// ============================================================

const { attemptShot } = require("./shotSystem");
const {
  initBallState,
  circulateBall,
  possessionPercent,
  syncBallToValidHolder,
} = require("./ballSystem");
const { checkCardEvents } = require("./cardSystem");
const { checkInjuryEvents } = require("./injurySystem");
const {
  MATCH_MINUTES,
  TICK_MS: DEFAULT_TICK_MS,
  CIRCULATION_MS: DEFAULT_CIRCULATION_MS,
  MAJOR_ACTION_LOCK_MS,
  SHOT_CHANCE_PER_TICK,
} = require("./timing");
const { applyNormalizedTacticsToTeam } = require("./tacticNormalize");
const { invalidateTeamCombat } = require("./ballSystem");
const { mt } = require("./matchI18n");

class Match {
  constructor(id, playerA, playerB, ioNamespace, options = {}) {
    this.id = id;
    this.io = ioNamespace;
    this.fixtureId = options.fixtureId || null;
    this.onEnd = options.onEnd || null;
    this.tickMs = options.tickMs || DEFAULT_TICK_MS;
    this.circulationMs = options.circulationMs || DEFAULT_CIRCULATION_MS;
    // Maç log dili: en / es / de / it / pt / fr / tr
    this.lang = options.lang || process.env.MATCH_LOG_LANG || "en";
    this.players = {
      home: {
        userId: playerA.userId,
        username: playerA.username,
        socketId: playerA.socketId,
        team: ensureTeamShape(playerA.team, playerA.username),
        isBot: !!playerA.isBot,
        clubId: playerA.clubId || null,
      },
      away: {
        userId: playerB.userId,
        username: playerB.username,
        socketId: playerB.socketId,
        team: ensureTeamShape(playerB.team, playerB.username),
        isBot: !!playerB.isBot,
        clubId: playerB.clubId || null,
      },
    };
    this.minute = 0;
    this.score = { home: 0, away: 0 };
    this.stats = {
      home: { shots: 0, onTarget: 0, goals: 0, possessionTicks: 0 },
      away: { shots: 0, onTarget: 0, goals: 0, possessionTicks: 0 },
    };
    this.log = [];
    this.scorers = [];
    this.startedAt = Date.now();
    this.status = "countdown";
    this.tickInterval = null;
    this.circulationInterval = null;
    this.subsUsed = { home: 0, away: 0 };
    this.subsMax = 5;
    initBallState(this);
  }

  room() {
    // Hem match odası hem fixture odası
    return this.id;
  }

  broadcast(event, payload) {
    if (!this.io) return;
    this.io.to(this.id).emit(event, payload);
    if (this.fixtureId) {
      this.io.to("fixture:" + this.fixtureId).emit(event, payload);
    }
  }

  addLog(text) {
    const entry = { minute: this.minute, text };
    this.log.push(entry);
    this.broadcast("match:log", entry);
  }

  start() {
    this.status = "live";
    this._stateSeq = 0;
    this._lastFullStateAt = 0;
    this._positionsDirty = true;
    this._cachedPositions = null;
    this.addLog(mt("match_start", this.lang));
    this.tickInterval = setInterval(() => this.tick(), this.tickMs);
    this.circulationInterval = setInterval(
      () => this.runCirculation(),
      this.circulationMs,
    );
    // Node process çıkışını engellemesin (özellikle bot-bot hızlı maçlarda)
    if (this.tickInterval && this.tickInterval.unref) this.tickInterval.unref();
    if (this.circulationInterval && this.circulationInterval.unref)
      this.circulationInterval.unref();
    this.broadcast("match:state", this.getPublicState(true));
  }

  runCirculation() {
    if (this.status !== "live") return;
    const event = circulateBall(this);
    if (event) this.addLog(event.text);
    // Sadece top/pozisyon — full state her pas'ta yayınlanmaz (bant/CPU)
    this.broadcast("match:ball", {
      holderName: this.ball.holderName,
      holderSide: this.ball.holderSide,
      possessionSide: this.possessionSide,
      x: this.ball.x,
      y: this.ball.y,
      minute: this.minute,
      score: this.score,
    });
  }

  // Bot taraf ara sıra skora göre oyun stilini ayarlar (küçük bir "yapay zeka" dokunuşu)
  maybeBotTactics() {
    ["home", "away"].forEach((side) => {
      const p = this.players[side];
      if (!p.isBot) return;
      if (Math.random() > 0.01) return; // dakikada ~%1 ihtimalle gözden geçir
      const otherSide = side === "home" ? "away" : "home";
      const diff = this.score[side] - this.score[otherSide];
      let style;
      if (diff < 0) style = "hücumsel";
      else if (diff > 0) style = "defansif";
      else style = ["hücumsel", "dengeli", "defansif"][Math.floor(Math.random() * 3)];
      p.team.gameStyle = style;
    });
  }

  tick() {
    if (this.status !== "live") return;
    this.minute++;
    this._stateSeq++;

    // Kart/sakatlık — seyrek örnekleme (her tick pahalı rastgele + tarama)
    if ((this.minute & 1) === 0) {
      checkCardEvents(this);
      checkInjuryEvents(this);
    }
    if (this.minute % 5 === 0) this.maybeBotTactics();

    let needFullState = false;

    if (!this.inMajorAction && Math.random() < SHOT_CHANCE_PER_TICK) {
      this.inMajorAction = true;
      const lock = Math.min(
        MAJOR_ACTION_LOCK_MS,
        Math.floor(this.tickMs * (400 / 900)),
      );
      setTimeout(() => {
        if (this.status !== "live") {
          this.inMajorAction = false;
          return;
        }
        try {
          const side = this.possessionSide || "home";
          const event = attemptShot(this, side);

          if (event && event.scored) {
            const receivingSide = side === "home" ? "away" : "home";
            this.ball.x = 300;
            this.ball.y = 200;
            this.ball.targetX = this.ball.x;
            this.ball.targetY = this.ball.y;
            this.ball.holderSide = receivingSide;
            this.possessionSide = receivingSide;
            this._positionsDirty = true;
            this.broadcast("match:ball", {
              holderName: this.ball.holderName,
              holderSide: this.ball.holderSide,
              possessionSide: this.possessionSide,
              x: this.ball.x,
              y: this.ball.y,
              minute: this.minute,
              score: this.score,
            });
          }
        } catch (err) {
          // Şut anında beklenmedik bir hata olsa bile inMajorAction kilitli
          // kalmamalı — aksi halde top bir daha asla dolaşmaz (donmuş top bug'ı).
          console.error("[matchEngine] attemptShot hata:", err);
        } finally {
          this.inMajorAction = false;
        }
        this.broadcast("match:state", this.getPublicState(true));
      }, lock);
      needFullState = true;
    }

    // Full state: şut anı veya her 5. dakika (skor/stats senkron)
    if (needFullState || this.minute % 5 === 0 || this.minute === 1) {
      this.broadcast("match:state", this.getPublicState(true));
    } else {
      // Hafif tick paketi — istemci dakika/skor günceller, pozisyon listesi yok
      this.broadcast("match:tick", {
        minute: this.minute,
        score: this.score,
        possessionSide: this.possessionSide,
        possession: possessionPercent(this),
      });
    }

    if (this.minute >= MATCH_MINUTES) {
      this.end();
    }
  }

  applyTacticChange(side, tactics) {
    const p = this.players[side];
    if (!p) return { ok: false, error: "Geçersiz taraf" };
    try {
      // Whitelist + Türkçe varyant normalize; customTactics da bağlanır
      applyNormalizedTacticsToTeam(p.team, tactics || {});
    } catch (_) {
      const allowed = ["passStyle", "gameStyle", "attackDir"];
      allowed.forEach((k) => {
        if (tactics && tactics[k]) p.team[k] = tactics[k];
      });
      if (tactics && tactics.customTactics && typeof tactics.customTactics === "object") {
        p.team.customTactics = Object.assign(
          {},
          p.team.customTactics || {},
          tactics.customTactics,
        );
      }
    }
    try {
      invalidateTeamCombat(p.team);
    } catch (_) {}
    {
      this.addLog(
        mt("tactic_change", this.lang, {
          min: this.minute,
          user: p.username,
        }),
      );
    }
    this.broadcast("match:state", this.getPublicState());
    return {
      ok: true,
      tactics: {
        passStyle: p.team.passStyle,
        gameStyle: p.team.gameStyle,
        attackDir: p.team.attackDir,
        pressIntensity: p.team.pressIntensity,
        transitionStyle: p.team.transitionStyle,
        customTactics: p.team.customTactics || {},
      },
    };
  }

  applySubstitution(side, outIdx, inIdx) {
    const p = this.players[side];
    if (!p) return { ok: false, error: "Geçersiz taraf" };
    if (this.subsUsed[side] >= this.subsMax) {
      return { ok: false, error: "Değişiklik hakkı bitti" };
    }
    const team = p.team;
    const outPlayer = team.players[outIdx];
    const inPlayer = team.bench[inIdx];
    if (!outPlayer || !inPlayer) {
      return { ok: false, error: "Geçersiz oyuncu seçimi" };
    }
    team.players[outIdx] = inPlayer;
    team.bench[inIdx] = outPlayer;
    this.subsUsed[side]++;
    this._positionsDirty = true;
    syncBallToValidHolder(this);
    {
      this.addLog(
        mt("sub", this.lang, {
          min: this.minute,
          user: p.username,
          out: outPlayer.name,
          inn: inPlayer.name,
        }),
      );
    }
    this.broadcast("match:state", this.getPublicState(true));
    return {
      ok: true,
      out: outPlayer.name,
      in: inPlayer.name,
      subsLeft: this.subsMax - this.subsUsed[side],
    };
  }

  end() {
    if (this.status === "ended") return;
    this.status = "ended";
    clearInterval(this.tickInterval);
    clearInterval(this.circulationInterval);
    {
      this.addLog(
        mt("match_end", this.lang, {
          home: this.players.home.username,
          away: this.players.away.username,
          hs: this.score.home,
          as: this.score.away,
        }),
      );
    }
    const state = this.getPublicState();
    this.broadcast("match:ended", state);
    if (typeof this.onEnd === "function") {
      try {
        const ret = this.onEnd(state, this);
        if (ret && typeof ret.then === "function") {
          ret.catch((e) => console.error("[match] onEnd async", e));
        }
      } catch (e) {
        console.error("[match] onEnd hata", e);
      }
    }
  }

  _buildPositions() {
    const mapSide = (side) =>
      (this.players[side].team.players || []).map((p) => ({
        name: p.name,
        pos: p.pos,
        x: p.x,
        y: p.y,
      }));
    return { home: mapSide("home"), away: mapSide("away") };
  }

  getPublicState(forcePositions) {
    if (forcePositions || this._positionsDirty || !this._cachedPositions) {
      this._cachedPositions = this._buildPositions();
      this._positionsDirty = false;
    }
    return {
      id: this.id,
      fixtureId: this.fixtureId,
      minute: this.minute,
      status: this.status,
      score: this.score,
      stats: this.stats,
      scorers: this.scorers,
      possession: possessionPercent(this),
      possessionSide: this.possessionSide,
      players: {
        home: {
          username: this.players.home.username,
          isBot: this.players.home.isBot,
          teamName: this.players.home.team.name,
          passStyle: this.players.home.team.passStyle,
          gameStyle: this.players.home.team.gameStyle,
          attackDir: this.players.home.team.attackDir,
          pressIntensity: this.players.home.team.pressIntensity,
          transitionStyle: this.players.home.team.transitionStyle,
          customTactics: this.players.home.team.customTactics || {},
        },
        away: {
          username: this.players.away.username,
          isBot: this.players.away.isBot,
          teamName: this.players.away.team.name,
          passStyle: this.players.away.team.passStyle,
          gameStyle: this.players.away.team.gameStyle,
          attackDir: this.players.away.team.attackDir,
          pressIntensity: this.players.away.team.pressIntensity,
          transitionStyle: this.players.away.team.transitionStyle,
          customTactics: this.players.away.team.customTactics || {},
        },
      },
      subsUsed: this.subsUsed,
      subsMax: this.subsMax,
      ball: this.ball
        ? { x: this.ball.x, y: this.ball.y, holderSide: this.ball.holderSide }
        : null,
      positions: this._cachedPositions,
    };
  }
}

function ensureTeamShape(team, fallbackName) {
  if (!team || typeof team !== "object") {
    const { createMockSquad } = require("./mockTeam");
    return createMockSquad((fallbackName || "Takım") + " FC");
  }
  team.name = team.name || fallbackName || "Takım";
  team.players = Array.isArray(team.players) ? team.players : [];
  team.bench = Array.isArray(team.bench) ? team.bench : [];
  try {
    applyNormalizedTacticsToTeam(team, {
      passStyle: team.passStyle || "kisa",
      gameStyle: team.gameStyle || "dengeli",
      attackDir: team.attackDir || "orta",
      customTactics: team.customTactics || {},
    });
  } catch (_) {
    team.gameStyle = team.gameStyle || "dengeli";
    team.passStyle = team.passStyle || "kisa";
    team.attackDir = team.attackDir || "orta";
    team.customTactics = team.customTactics || {};
  }
  team.matchBonuses = team.matchBonuses || {
    attack: 0,
    midfield: 0,
    defense: 0,
    gk: 0,
  };
  team.subsMax = team.subsMax || 5;
  const fill = (p, i) => {
    if (!p) return p;
    p.name = p.name || `Oyuncu ${i + 1}`;
    p.pos = p.pos || "MC";
    p.condition = p.condition != null ? p.condition : 90;
    p.sentOff = !!p.sentOff;
    p.cards = p.cards || 0;
    // Maç içi sayaç — kariyer DB değeriyle karışmasın
    p.goals = 0;
    p.assists = 0;
    p.saves = p.saves || 0;
    [
      "passing",
      "finishing",
      "pace",
      "technique",
      "positioning",
      "tackle",
      "stamina",
      "strength",
      "agility",
      "vision",
      "reflex",
    ].forEach((k) => {
      if (p[k] == null) p[k] = 10 + Math.floor(Math.random() * 6);
    });
    return p;
  };
  team.players = team.players.map(fill);
  team.bench = team.bench.map(fill);
  if (team.players.length < 11) {
    const { createMockSquad } = require("./mockTeam");
    const mock = createMockSquad(team.name);
    while (team.players.length < 11 && mock.players.length) {
      team.players.push(mock.players.shift());
    }
    if (!team.bench.length) team.bench = mock.bench || [];
  }
  // x/y yoksa formasyon slotlarına yerleştir (saha boş kalmasın)
  const slots = [
    { x: 50, y: 200 },
    { x: 130, y: 50 },
    { x: 125, y: 140 },
    { x: 125, y: 260 },
    { x: 130, y: 350 },
    { x: 210, y: 200 },
    { x: 300, y: 145 },
    { x: 300, y: 255 },
    { x: 410, y: 200 },
    { x: 495, y: 55 },
    { x: 495, y: 345 },
  ];
  team.players.forEach((p, i) => {
    if (!p) return;
    if (p.x == null || p.y == null || !Number.isFinite(Number(p.x))) {
      const slot = slots[i] || slots[slots.length - 1];
      p.x = slot.x;
      p.y = slot.y;
    }
  });
  (team.bench || []).forEach((p) => {
    if (!p) return;
    if (p.x == null || p.y == null) {
      p.x = 300;
      p.y = 200;
    }
  });
  return team;
}

module.exports = { Match };
