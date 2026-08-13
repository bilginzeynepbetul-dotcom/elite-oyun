// ============================================================
// antiCheat.js — Sunucu tarafı hile koruması
// ------------------------------------------------------------
// 1) Oyuncu skill / yaş / kadro sanitizasyonu
// 2) Skill sıçrama tespiti (DB ile karşılaştırma)
// 3) Rate limit
// 4) Şüpheli aktivite audit logu
// 5) Transfer / bütçe yardımcı doğrulamalar
// ============================================================

const { query } = require("./db");

const SKILL_KEYS = [
  "pace",
  "passing",
  "finishing",
  "tackle",
  "vision",
  "stamina",
  "strength",
  "technique",
  "agility",
  "positioning",
  "reflex",
  "handling",
  "dribbling",
];

const LIMITS = {
  skillMin: 1,
  skillMax: 20,
  ageMin: 15,
  ageMax: 45,
  conditionMin: 20,
  conditionMax: 100,
  formMin: -5,
  formMax: 10,
  experienceMin: 0,
  experienceMax: 100,
  happinessMin: 0,
  happinessMax: 100,
  qualityMin: 1,
  qualityMax: 10,
  maxSquad: 40, // starters + bench
  maxStarters: 11,
  maxBench: 18,
  /** Mevcut skill'den tek seferde en fazla +N (maç/antrenman sunucuda) */
  maxSkillJump: 1.5,
  /** Yeni oyuncu (id yok) max ortalama skill — market/akademi tavanı */
  maxNewPlayerAvgSkill: 14,
  /** Transfer teklif tavanı (makul üst) */
  maxBidAmount: 500_000_000,
  minBidAmount: 1000,
};

// ---------- Rate limit (bellek) ----------
const _rateBuckets = new Map(); // key → { count, resetAt }

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    _rateBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    return {
      ok: false,
      error: "Çok fazla istek. Biraz bekleyip tekrar dene.",
      code: "RATE_LIMIT",
      retryAfterMs: Math.max(0, b.resetAt - now),
    };
  }
  return { ok: true };
}

/** Express middleware factory */
function rateLimitMiddleware(opts) {
  const max = (opts && opts.max) || 60;
  const windowMs = (opts && opts.windowMs) || 60_000;
  const prefix = (opts && opts.prefix) || "api";
  return function (req, res, next) {
    const uid = (req.user && req.user.id) || req.ip || "anon";
    const path = (req.route && req.route.path) || req.path || "";
    const r = rateLimit(prefix + ":" + uid + ":" + path, max, windowMs);
    if (!r.ok) {
      res.setHeader("Retry-After", String(Math.ceil((r.retryAfterMs || 1000) / 1000)));
      return res.status(429).json(r);
    }
    next();
  };
}

// ---------- Audit ----------
async function logSuspicious(userId, clubId, action, detail) {
  try {
    await query(
      `INSERT INTO anti_cheat_log (user_id, club_id, action, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        userId || null,
        clubId || null,
        String(action || "unknown").slice(0, 64),
        JSON.stringify(detail || {}),
      ],
    );
  } catch (e) {
    // tablo yoksa sessizce konsola
    console.warn(
      "[antiCheat]",
      action,
      userId,
      clubId,
      typeof detail === "object" ? JSON.stringify(detail).slice(0, 200) : detail,
    );
  }
}

// ---------- Sayısal yardımcı ----------
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function playerAvgSkill(p) {
  let s = 0,
    n = 0;
  SKILL_KEYS.forEach((k) => {
    if (p[k] != null && Number.isFinite(Number(p[k]))) {
      s += Number(p[k]);
      n++;
    }
  });
  return n ? s / n : 10;
}

/**
 * Tek oyuncuyu temizle (clamp). Mutates copy.
 */
function sanitizePlayer(p) {
  if (!p || typeof p !== "object") return null;
  const out = Object.assign({}, p);
  SKILL_KEYS.forEach((k) => {
    if (out[k] != null) {
      out[k] = clampNum(out[k], LIMITS.skillMin, LIMITS.skillMax, 10);
    }
  });
  out.age = clampNum(out.age, LIMITS.ageMin, LIMITS.ageMax, 18);
  out.condition = clampNum(
    out.condition,
    LIMITS.conditionMin,
    LIMITS.conditionMax,
    90,
  );
  out.form = clampNum(out.form, LIMITS.formMin, LIMITS.formMax, 0);
  out.experience = clampNum(
    out.experience,
    LIMITS.experienceMin,
    LIMITS.experienceMax,
    3,
  );
  out.happiness = clampNum(
    out.happiness,
    LIMITS.happinessMin,
    LIMITS.happinessMax,
    80,
  );
  if (out.baseQuality != null) {
    out.baseQuality = clampNum(
      out.baseQuality,
      LIMITS.qualityMin,
      LIMITS.qualityMax,
      5,
    );
  }
  if (out.basePotential != null) {
    out.basePotential = clampNum(
      out.basePotential,
      LIMITS.qualityMin,
      LIMITS.qualityMax,
      5,
    );
  }
  // Client'tan gelen goals/assists maç motoru dışında şişirilmesin — soft cap
  if (out.goals != null) out.goals = clampNum(out.goals, 0, 500, 0);
  if (out.assists != null) out.assists = clampNum(out.assists, 0, 500, 0);
  return out;
}

/**
 * Kayıtlı oyuncu ile gelen oyuncu arasında skill sıçraması var mı?
 * maxJump aşımlarını eski değere çeker ve flag döner.
 */
function enforceSkillDelta(incoming, existing) {
  if (!existing || !incoming) {
    return { player: incoming, flags: [] };
  }
  const flags = [];
  const out = Object.assign({}, incoming);
  SKILL_KEYS.forEach((k) => {
    if (out[k] == null || existing[k] == null) return;
    const oldV = Number(existing[k]);
    const newV = Number(out[k]);
    if (!Number.isFinite(oldV) || !Number.isFinite(newV)) return;
    const jump = newV - oldV;
    if (jump > LIMITS.maxSkillJump) {
      flags.push({
        skill: k,
        from: oldV,
        to: newV,
        clamped: oldV + LIMITS.maxSkillJump,
      });
      out[k] = Math.min(
        LIMITS.skillMax,
        Math.round((oldV + LIMITS.maxSkillJump) * 10) / 10,
      );
    }
  });
  return { player: out, flags };
}

/**
 * Takım payload'ını doğrula + temizle.
 * existingTeam: DB'den getTeam sonucu (players+bench)
 */
function sanitizeTeamPayload(team, existingTeam) {
  const flags = [];
  if (!team || typeof team !== "object") {
    return { ok: false, error: "Geçersiz takım verisi", code: "BAD_TEAM" };
  }

  // Client balance asla güvenilmez
  if (team.budget != null || team.balance != null || team.clubBudget != null) {
    flags.push({ type: "balance_ignored", msg: "Client bütçe alanı yok sayıldı" });
    delete team.budget;
    delete team.balance;
    delete team.clubBudget;
  }

  let players = Array.isArray(team.players) ? team.players.slice() : [];
  let bench = Array.isArray(team.bench) ? team.bench.slice() : [];

  if (players.length > LIMITS.maxStarters) {
    flags.push({ type: "starters_trim", from: players.length });
    players = players.slice(0, LIMITS.maxStarters);
  }
  if (bench.length > LIMITS.maxBench) {
    flags.push({ type: "bench_trim", from: bench.length });
    bench = bench.slice(0, LIMITS.maxBench);
  }
  if (players.length + bench.length > LIMITS.maxSquad) {
    return {
      ok: false,
      error: "Kadro limiti aşıldı (max " + LIMITS.maxSquad + ")",
      code: "SQUAD_LIMIT",
    };
  }

  // existing map by id
  const existingMap = {};
  if (existingTeam) {
    []
      .concat(existingTeam.players || [], existingTeam.bench || [])
      .forEach((p) => {
        if (p && p.id) existingMap[String(p.id)] = p;
      });
  }

  const cleanList = (list, role) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      let p = sanitizePlayer(list[i]);
      if (!p) continue;
      if (p.id && existingMap[String(p.id)]) {
        const r = enforceSkillDelta(p, existingMap[String(p.id)]);
        p = r.player;
        if (r.flags.length) {
          flags.push({
            type: "skill_jump",
            role,
            playerId: p.id,
            name: p.name,
            skills: r.flags,
          });
        }
      } else if (!p.id || !existingMap[String(p.id)]) {
        // Yeni oyuncu — ortalama skill tavanı
        const avg = playerAvgSkill(p);
        if (avg > LIMITS.maxNewPlayerAvgSkill) {
          flags.push({
            type: "new_player_overpowered",
            role,
            name: p.name,
            avg: Math.round(avg * 10) / 10,
          });
          // skill'leri orantılı düşür
          const scale = LIMITS.maxNewPlayerAvgSkill / avg;
          SKILL_KEYS.forEach((k) => {
            if (p[k] != null) {
              p[k] = clampNum(
                Number(p[k]) * scale,
                LIMITS.skillMin,
                LIMITS.skillMax,
                10,
              );
            }
          });
        }
      }
      out.push(p);
    }
    return out;
  };

  players = cleanList(players, "starter");
  bench = cleanList(bench, "bench");

  // Duplike id engeli
  const seen = new Set();
  const dedupe = (list) =>
    list.filter((p) => {
      if (!p.id) return true;
      const id = String(p.id);
      if (seen.has(id)) {
        flags.push({ type: "duplicate_id", id });
        return false;
      }
      seen.add(id);
      return true;
    });
  players = dedupe(players);
  bench = dedupe(bench);

  const sanitized = Object.assign({}, team, { players, bench });
  // Stil alanları whitelist
  try {
    const {
      applyNormalizedTacticsToTeam,
    } = require("./tacticNormalize");
    applyNormalizedTacticsToTeam(sanitized, {
      passStyle: sanitized.passStyle,
      gameStyle: sanitized.gameStyle,
      attackDir: sanitized.attackDir,
      customTactics: sanitized.customTactics,
    });
  } catch (_) {
    if (sanitized.gameStyle && typeof sanitized.gameStyle === "string") {
      const ok = ["dengeli", "hücumsel", "defansif", "balanced", "attacking", "defensive"];
      if (!ok.includes(sanitized.gameStyle)) sanitized.gameStyle = "dengeli";
    }
    if (sanitized.passStyle && typeof sanitized.passStyle === "string") {
      const okP = ["kisa", "kısa", "uzun", "hizli", "hızlı", "karisik", "karışık"];
      if (!okP.includes(sanitized.passStyle)) sanitized.passStyle = "kisa";
    }
    if (sanitized.attackDir && typeof sanitized.attackDir === "string") {
      const okA = ["orta", "kanatlardan", "sol", "sag", "sağ"];
      if (!okA.includes(sanitized.attackDir)) sanitized.attackDir = "orta";
    }
  }

  return { ok: true, team: sanitized, flags };
}

/** Transfer teklif tutarı */
function validateBidAmount(amount, clubBalance) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < LIMITS.minBidAmount) {
    return { ok: false, error: "Geçersiz teklif tutarı", code: "BAD_BID" };
  }
  if (n > LIMITS.maxBidAmount) {
    return { ok: false, error: "Teklif üst limiti aşıldı", code: "BID_CAP" };
  }
  if (clubBalance != null && n > Number(clubBalance)) {
    return { ok: false, error: "Yetersiz bütçe", code: "NO_FUNDS" };
  }
  return { ok: true, amount: Math.floor(n) };
}

/** Maç skoru client'tan gelirse reddet (sunucu motoru yazar) */
function rejectClientMatchResult(body) {
  if (!body || typeof body !== "object") return { ok: true };
  const keys = Object.keys(body);
  const suspicious =
    body.homeGoals != null ||
    body.awayGoals != null ||
    body.home_goals != null ||
    body.away_goals != null ||
    body.score != null ||
    body.finalScore != null ||
    body.matchResult != null ||
    body.result != null ||
    body.pts != null ||
    body.standings != null ||
    body.leagueTable != null ||
    (body.team &&
      (body.team.homeGoals != null ||
        body.team.awayGoals != null ||
        body.team.score != null ||
        body.team.matchResult != null));
  // Nested payload
  if (
    !suspicious &&
    body.match &&
    typeof body.match === "object" &&
    (body.match.homeGoals != null ||
      body.match.awayGoals != null ||
      body.match.score != null)
  ) {
    return {
      ok: false,
      error: "Maç sonucu yalnızca sunucu tarafından yazılır",
      code: "CLIENT_MATCH_RESULT",
    };
  }
  if (suspicious) {
    return {
      ok: false,
      error: "Maç sonucu yalnızca sunucu tarafından yazılır",
      code: "CLIENT_MATCH_RESULT",
    };
  }
  return { ok: true };
}

module.exports = {
  LIMITS,
  SKILL_KEYS,
  rateLimit,
  rateLimitMiddleware,
  logSuspicious,
  sanitizePlayer,
  sanitizeTeamPayload,
  enforceSkillDelta,
  validateBidAmount,
  rejectClientMatchResult,
  clampNum,
  playerAvgSkill,
};
