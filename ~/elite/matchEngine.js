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

class Match {
  constructor(id, playerA, playerB, ioNamespace, options = {}) {
    this.id = id;
    this.io = ioNamespace;
    this.fixtureId = options.fixtureId || null;
    this.onEnd = options.onEnd || null;
    this.tickMs = options.tickMs || DEFAULT_TICK_MS;
    this.circulationMs = options.circulationMs || DEFAULT_CIRCULATION_MS;
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
    this.addLog("⚽ Maç başladı!");
    this.tickInterval = setInterval(() => this.tick(), this.tickMs);
    this.circulationInterval = setInterval(
      () => this.runCirculation(),
      this.circulationMs,
    );
    this.broadcast("match:state", this.getPublicState());
  }

  runCirculation() {
    if (this.status !== "live") return;
    const event = circulateBall(this);
    if (event) this.addLog(event.text);
    this.broadcast("match:ball", {
      holderName: this.ball.holderName,
      holderSide: this.ball.holderSide,
      possessionSide: this.possessionSide,
      x: this.ball.x,
      y: this.ball.y,
    });
  }

  tick() {
    if (this.status !== "live") return;
    this.minute++;

    checkCardEvents(this).forEach((e) => this.addLog(e.text));
    checkInjuryEvents(this).forEach((e) => this.addLog(e.text));
    this.maybeBotTactics();

    if (!this.inMajorAction && Math.random() < SHOT_CHANCE_PER_TICK) {
      this.inMajorAction = true;
      const lock = Math.min(MAJOR_ACTION_LOCK_MS, Math.floor(this.tickMs * (400 / 900)));
      setTimeout(() => {
        if (this.status !== "live") return;
        const event = attemptShot(this);
        if (event) {
          // Şut anında topu hücum eden tarafın kale çizgisine taşı (görsel yön ipucu)
          this.ball.x = event.side === "home" ? 580 : 20;
          this.ball.y = 200;
          this.ball.targetX = this.ball.x;
          this.ball.targetY = this.ball.y;
          this.ball.holderName = event.striker;
          this.ball.holderSide = event.side;
          this.broadcast("match:ball", {
            holderName: this.ball.holderName,
            holderSide: this.ball.holderSide,
            possessionSide: this.possessionSide,
            x: this.ball.x,
            y: this.ball.y,
          });
          const scoreLine =
            event.type === "goal" ? ` (${this.score.home}-${this.score.away})` : "";
          this.addLog(`${event.text}${scoreLine}`);
          if (event.type === "goal") {
            this.scorers.push({
              minute: this.minute,
              name: event.striker,
              assist: event.assist || null,
              side: event.side,
              team: this.players[event.side].username,
            });
            this.broadcast("match:goal", {
              side: event.side,
              scorer: event.striker,
              assist: event.assist,
              score: this.score,
              scorers: this.scorers,
            });
          }
        }
        this.broadcast("match:state", this.getPublicState());
        this.inMajorAction = false;
      }, lock);
    }

    this.broadcast("match:state", this.getPublicState());

    if (this.minute >= MATCH_MINUTES) {
      this.end();
    }
  }

  maybeBotTactics() {
    ["home", "away"].forEach((side) => {
      if (!this.players[side].isBot) return;
      if (Math.random() > 0.03) return;
      const team = this.players[side].team;
      const styles = ["dengeli", "hücumsel", "defansif"];
      const passes = ["kısa", "uzun", "hızlı"];
      team.gameStyle = styles[Math.floor(Math.random() * styles.length)];
      team.passStyle = passes[Math.floor(Math.random() * passes.length)];
    });
  }

  applyTacticChange(side, tactics) {
    // Canlı maçta taktik değişimi (maç içi)
    const team = this.players[side].team;
    if (!tactics || typeof tactics !== "object") return;
    if (tactics.passStyle) team.passStyle = tactics.passStyle;
    if (tactics.gameStyle) team.gameStyle = tactics.gameStyle;
    if (tactics.attackDir) team.attackDir = tactics.attackDir;
    this.addLog(
      `${this.minute}' ${this.players[side].username} taktik: ${tactics.gameStyle || ""} ${tactics.passStyle || ""}`.trim(),
    );
  }

  applySubstitution(side, outIdx, inIdx) {
    const team = this.players[side].team;
    if (this.subsUsed[side] >= this.subsMax) {
      return { ok: false, error: "Değişiklik hakkı bitti" };
    }
    outIdx = Number(outIdx);
    inIdx = Number(inIdx);
    if (
      isNaN(outIdx) ||
      isNaN(inIdx) ||
      outIdx < 0 ||
      outIdx >= team.players.length ||
      inIdx < 0 ||
      inIdx >= (team.bench || []).length
    ) {
      return { ok: false, error: "Geçersiz indeks" };
    }
    const outPlayer = team.players[outIdx];
    if (outPlayer.sentOff) return { ok: false, error: "Oyuncu sahada değil" };
    const inPlayer = team.bench.splice(inIdx, 1)[0];
    inPlayer.pos = outPlayer.pos;
    inPlayer.naturalPos = inPlayer.naturalPos || inPlayer.pos;
    inPlayer.x = outPlayer.x;
    inPlayer.y = outPlayer.y;
    inPlayer.minutesPlayed = Math.max(0, 90 - this.minute);
    inPlayer.condition = Math.min(100, (inPlayer.condition || 85) + 5);
    outPlayer.minutesPlayed = this.minute;
    team.players[outIdx] = inPlayer;
    team.bench.push(outPlayer);
    this.subsUsed[side]++;
    syncBallToValidHolder(this);
    this.addLog(
      `${this.minute}' Değişiklik: ${outPlayer.name} ↔ ${inPlayer.name}`,
    );
    this.broadcast("match:state", this.getPublicState());
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
    this.addLog(
      `🏁 Maç bitti: ${this.players.home.username} ${this.score.home} - ${this.score.away} ${this.players.away.username}`,
    );
    const state = this.getPublicState();
    this.broadcast("match:ended", state);
    if (typeof this.onEnd === "function") {
      try {
        this.onEnd(state);
      } catch (e) {
        console.error("[match] onEnd", e);
      }
    }
  }

  getPublicState() {
    const poss = possessionPercent(this);
    return {
      id: this.id,
      fixtureId: this.fixtureId,
      minute: this.minute,
      status: this.status,
      score: this.score,
      stats: {
        home: {
          shots: this.stats.home.shots,
          onTarget: this.stats.home.onTarget,
          goals: this.stats.home.goals,
          possession: poss.home,
        },
        away: {
          shots: this.stats.away.shots,
          onTarget: this.stats.away.onTarget,
          goals: this.stats.away.goals,
          possession: poss.away,
        },
      },
      possessionSide: this.possessionSide,
      players: {
        home: {
          username: this.players.home.username,
          isBot: !!this.players.home.isBot,
          teamName: this.players.home.team.name,
        },
        away: {
          username: this.players.away.username,
          isBot: !!this.players.away.isBot,
          teamName: this.players.away.team.name,
        },
      },
      subsUsed: this.subsUsed,
      subsMax: this.subsMax,
      scorers: this.scorers || [],
      // Canvas animasyonu için: top + statik formasyon koordinatları.
      // Oyuncu x/y'si sadece diziliş/değişiklik olduğunda değişir; her
      // tick'te tekrar hesaplanmaz (bkz. teamUtils.assignFormationPositions).
      ball: { x: this.ball.x, y: this.ball.y, holderSide: this.ball.holderSide },
      positions: {
        home: this.players.home.team.players.map((p) => ({
          name: p.name,
          pos: p.pos,
          x: p.x,
          y: p.y,
        })),
        away: this.players.away.team.players.map((p) => ({
          name: p.name,
          pos: p.pos,
          x: p.x,
          y: p.y,
        })),
      },
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
  team.gameStyle = team.gameStyle || "dengeli";
  team.passStyle = team.passStyle || "kısa";
  team.attackDir = team.attackDir || "orta";
  team.matchBonuses = team.matchBonuses || {
    attack: 0,
    midfield: 0,
    defense: 0,
    gk: 0,
  };
  team.customTactics = team.customTactics || {};
  team.subsMax = team.subsMax || 5;
  const fill = (p, i) => {
    if (!p) return p;
    p.name = p.name || `Oyuncu ${i + 1}`;
    p.pos = p.pos || "MC";
    p.condition = p.condition != null ? p.condition : 90;
    p.sentOff = !!p.sentOff;
    p.cards = p.cards || 0;
    p.goals = p.goals || 0;
    p.assists = p.assists || 0;
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
  return team;
}

module.exports = { Match };
