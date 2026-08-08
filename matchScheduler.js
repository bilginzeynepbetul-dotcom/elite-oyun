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
const nationalRepo = require("./repos/nationalRepo");
const nationalSystem = require("./nationalSystem");
const { COUNTRY } = require("./nationalRoutes");

let timer = null;
let running = false;

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
  // A Milli + U21 dostluk fikstürlerini doldur ve zamanı gelenleri başlat
  try {
    await nationalSystem.ensureAllNationalFixtures(COUNTRY);
  } catch (e) {
    console.warn("[scheduler] national ensure fixtures", e.message);
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

async function tick(ctx) {
  if (running) return; // önceki tur bitmeden yenisini başlatma
  running = true;
  try {
    await tickLeague(ctx);
    await tickCup(ctx);
    await tickFriendly(ctx);
    await tickNational(ctx);
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

module.exports = { startScheduler, stopScheduler };
