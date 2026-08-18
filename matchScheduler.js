
async function tickWeeklyFriendlies() {
  try {
    const comp = require("./competitionBootstrap");
    // ISO hafta anahtarı — haftada bir kez otomatik dostluk planı
    const now = new Date();
    const onejan = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const week = Math.ceil(
      ((now - onejan) / 86400000 + onejan.getUTCDay() + 1) / 7,
    );
    const weekKey = now.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
    if (tickWeeklyFriendlies._lastWeek === weekKey) return;
    tickWeeklyFriendlies._lastWeek = weekKey;
    const r = await comp.scheduleWeeklyFriendlies();
    if (r && r.scheduled)
      console.log("[scheduler] weekly friendlies +", r.scheduled);
  } catch (e) {
    console.warn("[scheduler] weekly friendlies", e.message);
  }
}

// ============================================================
// matchScheduler.js — Zamanı gelen fikstürleri otomatik başlatır
// ------------------------------------------------------------
// Periyodik olarak (varsayılan 15sn) lig, kupa ve hazırlık maçı
// fikstürlerini tarar; kickoff_at <= NOW() ve status='scheduled'
// olanları matchEngine.Match ile canlı başlatır.
//
//   const { startScheduler } = require("./matchScheduler");
//   startScheduler({ io, liveMatches });
// ============================================================

const { Match } = require("./matchEngine");
const leagueRepo = require("./repos/leagueRepo");
const cupRepo = require("./repos/cupRepo");
const friendlySystem = require("./friendlySystem");

const { startFixtureMatch } = require("./matchLifecycle");
const { startCupFixtureMatch } = require("./cupLifecycle");
const { startFriendlyFixtureMatch } = require("./friendlyLifecycle");
const { startNationalFixtureMatch } = require("./nationalLifecycle");
const { startContinentalFixtureMatch } = require("./continentalLifecycle");
const { startEliteCupFixtureMatch } = require("./eliteCupLifecycle");
const nationalRepo = require("./repos/nationalRepo");
const continentalRepo = require("./repos/continentalRepo");
const eliteCupRepo = require("./repos/eliteCupRepo");
const nationalSystem = require("./nationalSystem");
const { COUNTRY } = require("./nationalRoutes");

let timer = null;
let running = false;
let seasonAutoCounter = 0;

async function tickLeague({ io, liveMatches }) {
  const due = await leagueRepo.listDueFixtures(20);
  for (const f of due) {
    try {
      await startFixtureMatch({ fixtureId: f.id, io, liveMatches, MatchClass: Match });
      console.log("[scheduler] lig maçı başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] lig maçı başlatılamadı", f.id, e.message);
    }
  }
}

async function tickCup({ io, liveMatches }) {
  const due = await cupRepo.listDueFixtures(20);
  for (const f of due) {
    try {
      await startCupFixtureMatch({ fixtureId: f.id, io, liveMatches, MatchClass: Match });
      console.log("[scheduler] kupa maçı başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] kupa maçı başlatılamadı", f.id, e.message);
    }
  }
  // Turu tamamlanan kupa edisyonlarını ilerlet (biten maç yoksa bile
  // bye/eksik eşleşme gibi durumlar için periyodik kontrol faydalı)
  try {
    await cupRepo.advanceReadyEditions();
  } catch (e) {
    console.warn("[scheduler] cup advanceReadyEditions", e.message);
  }
}


async function tickContinental({ io, liveMatches }) {
  const due = await continentalRepo.listDueFixtures(15);
  for (const f of due) {
    try {
      await startContinentalFixtureMatch({
        fixtureId: f.id,
        io,
        liveMatches,
        MatchClass: Match,
      });
      console.log("[scheduler] Kıtasal Lig maçı başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] Kıtasal Lig maçı başlatılamadı", f.id, e.message);
    }
  }
}

async function tickEliteCup({ io, liveMatches }) {
  const due = await eliteCupRepo.listDueFixtures(20);
  for (const f of due) {
    try {
      await startEliteCupFixtureMatch({
        fixtureId: f.id,
        io,
        liveMatches,
        MatchClass: Match,
      });
      console.log("[scheduler] Elite Kupa maçı başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] Elite Kupa maçı başlatılamadı", f.id, e.message);
    }
  }
  try {
    await eliteCupRepo.advanceReadyEditions();
  } catch (e) {
    console.warn("[scheduler] eliteCup advance", e.message);
  }
}

async function tickFriendly({ io, liveMatches }) {
  const due = await friendlySystem.listDue(20);
  for (const f of due) {
    try {
      await startFriendlyFixtureMatch({ fixtureId: f.id, io, liveMatches, MatchClass: Match });
      console.log("[scheduler] hazırlık maçı başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] hazırlık maçı başlatılamadı", f.id, e.message);
    }
  }
}

async function tickNational({ io, liveMatches }) {
  // A Milli + U21 dostluk fikstürlerini doldur (tüm ülkeler) ve başlat
  const countries = new Set([COUNTRY || "Türkiye"]);
  try {
    const { query } = require("./db");
    const { rows } = await query(
      `SELECT DISTINCT country FROM national_teams WHERE country IS NOT NULL`,
    );
    (rows || []).forEach(function (r) {
      if (r.country) countries.add(r.country);
    });
  } catch (e) {}
  for (const c of countries) {
    try {
      await nationalSystem.ensureAllNationalFixtures(c);
    } catch (e) {
      console.warn("[scheduler] national ensure fixtures", c, e && e.message);
    }
  }
  const due = await nationalRepo.listDueFixtures(10);
  for (const f of due) {
    try {
      await startNationalFixtureMatch({
        fixtureId: f.id,
        io,
        liveMatches,
        MatchClass: Match,
      });
      console.log("[scheduler] milli maç başladı", f.id);
    } catch (e) {
      console.warn("[scheduler] milli maç başlatılamadı", f.id, e.message);
    }
  }
}


/** Biten veya takılı kalmış maçları registry'den temizle */
function cleanupZombieMatches(liveMatches) {
  if (!liveMatches || typeof liveMatches.entries !== "function") return 0;
  let removed = 0;
  const now = Date.now();
  for (const [id, match] of liveMatches.entries()) {
    try {
      if (!match) {
        liveMatches.delete(id);
        removed++;
        continue;
      }
      const st = match.status || (match.state && match.state.status);
      if (st === "ended" || st === "finished" || st === "cancelled") {
        try {
          if (match.tickInterval) clearInterval(match.tickInterval);
          if (match.circulationInterval) clearInterval(match.circulationInterval);
        } catch (e) {}
        liveMatches.delete(id);
        removed++;
        continue;
      }
      // 25 dk'dan uzun süren canlı maç = takılı
      const started =
        match.startedAt ||
        match._startedAt ||
        (match.state && match.state.startedAt) ||
        0;
      if (started && now - started > 25 * 60 * 1000) {
        console.warn("[scheduler] zombie match force-end", id);
        try {
          if (typeof match.end === "function") match.end();
        } catch (e) {}
        liveMatches.delete(id);
        removed++;
      }
    } catch (e) {
      try {
        liveMatches.delete(id);
        removed++;
      } catch (e2) {}
    }
  }
  return removed;
}

async function tick(ctx) {
  if (running) return; // önceki tur bitmeden yenisini başlatma
  running = true;
  try {
    const z = cleanupZombieMatches(ctx.liveMatches);
    if (z) console.log("[scheduler] zombie cleaned", z);
    await tickLeague(ctx);
    await tickCup(ctx);
    await tickContinental(ctx);
    await tickEliteCup(ctx);
    await tickFriendly(ctx);
    await tickNational(ctx);
    await tickWeeklyFriendlies();

    // Saati gelmiş maçları puan durumuna işle (motor başlatılamayanlar dahil)
    try {
      const { autoResolveDueMatches } = require("./seasonAutomation");
      const ar = await autoResolveDueMatches();
      if (ar && ar.resolved) {
        console.log("[scheduler] autoResolve", ar.resolved);
      }
    } catch (eAr) {
      console.warn("[scheduler] autoResolve", eAr.message);
    }

    // Maç bildirimleri: her tick (hafif sorgu)
    try {
      const { runMatchNotify } = require("./matchNotify");
      const mn = await runMatchNotify();
      if (mn && mn.notified) {
        console.log("[scheduler] matchNotify", mn.notified);
      }
    } catch (eMn) {
      console.warn("[scheduler] matchNotify", eMn.message);
    }

    // Sezon otomasyonu: her 4 tick'te bir (~60sn @15s interval)
    seasonAutoCounter++;
    if (seasonAutoCounter >= 4) {
      seasonAutoCounter = 0;
      try {
        const { runSeasonAutomation } = require("./seasonAutomation");
        const auto = await runSeasonAutomation(ctx);
        if (
          auto &&
          ((auto.stuckLive && auto.stuckLive.processed) ||
            (auto.overdue && auto.overdue.forfeited) ||
            (auto.pendingFinalize && auto.pendingFinalize.finalized) ||
            (auto.monthly && auto.monthly.ok && !auto.monthly.skipped && !auto.monthly.empty))
        ) {
          console.log("[scheduler] seasonAutomation", JSON.stringify(auto));
        }
      } catch (eAuto) {
        console.warn("[scheduler] seasonAutomation", eAuto.message);
      }
    }
  } catch (e) {
    console.error("[scheduler] tick error", e);
  } finally {
    running = false;
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.io] - socket.io server (null olabilir, sadece izleyici yayını kesilir)
 * @param {Map} opts.liveMatches - fixtureId → Match instance registry
 * @param {number} [opts.intervalMs] - tarama sıklığı (varsayılan 15000)
 */
function startScheduler(opts) {
  const { io, liveMatches, intervalMs = 15000 } = opts;
  if (timer) return timer;
  const ctx = { io, liveMatches };
  // Sunucu açılışında bekleyen maçları hemen bir kere kontrol et
  tick(ctx).catch((e) => console.error("[scheduler] ilk tick", e));
  timer = setInterval(() => {
    tick(ctx).catch((e) => console.error("[scheduler] tick", e));
  }, intervalMs);
  console.log(`✅ Maç zamanlayıcı çalışıyor (${intervalMs}ms aralık)`);
  return timer;
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { startScheduler, stopScheduler, cleanupZombieMatches };
