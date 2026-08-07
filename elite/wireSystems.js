// ============================================================
// wireSystems.js — Tüm domain sistemlerini DB repo'lara bağla
// ------------------------------------------------------------
//   const { wireAll } = require("./wireSystems");
//   wireAll();
//   // sonra Express route'larını mount et
// ============================================================

const clubsRepo = require("./repos/clubsRepo");
const youthRepo = require("./repos/youthRepo");
const stadiumRepo = require("./repos/stadiumRepo");
const trainingRepo = require("./repos/trainingRepo");
const socialRepo = require("./repos/socialRepo");
const transferRepo = require("./repos/transferRepo");

function wireAll() {
  let transferSystem, youthSystem, trainingSystem, stadiumSystem, socialSystem;

  try {
    transferSystem = require("./transferSystem");
    transferSystem.configure({
      getClub: clubsRepo.getClub,
      adjustBalance: clubsRepo.adjustBalance,
      getTeam: clubsRepo.getTeam,
      saveTeam: clubsRepo.saveTeam,
      persistListing: transferRepo.upsertListing,
      persistBid: transferRepo.insertBid,
      removeListing: async (id, status) => {
        try {
          await transferRepo.setListingStatus(id, status || "expired");
        } catch (e) {
          // row may not exist yet for pure AI memory-only
        }
      },
    });
    // hydrate from DB
    transferRepo.loadActiveListings().then((rows) => {
      if (rows && rows.length) {
        transferSystem.loadAll(rows);
        console.log("[wire] transfer listings loaded", rows.length);
      }
      transferSystem.startSettlementTimer(30_000);
    }).catch((e) => {
      console.warn("[wire] transfer load", e.message);
      transferSystem.startSettlementTimer(30_000);
    });
  } catch (e) {
    console.warn("[wire] transferSystem", e.message);
  }

  try {
    youthSystem = require("./youthSystem");
    youthSystem.configure({
      getClub: clubsRepo.getClub,
      adjustBalance: clubsRepo.adjustBalance,
      getTeam: clubsRepo.getTeam,
      saveTeam: clubsRepo.saveTeam,
      getYouthState: youthRepo.getYouthState,
      saveYouthState: youthRepo.saveYouthState,
    });
    youthSystem.startUpgradeTimer(5_000);
  } catch (e) {
    console.warn("[wire] youthSystem", e.message);
  }

  try {
    trainingSystem = require("./trainingSystem");
    trainingSystem.configure({
      getClub: clubsRepo.getClub,
      adjustBalance: clubsRepo.adjustBalance,
      getTeam: clubsRepo.getTeam,
      saveTeam: clubsRepo.saveTeam,
      getTrainingState: trainingRepo.getTrainingState,
      saveTrainingState: trainingRepo.saveTrainingState,
    });
  } catch (e) {
    console.warn("[wire] trainingSystem", e.message);
  }

  try {
    stadiumSystem = require("./stadiumSystem");
    stadiumSystem.configure({
      getClub: clubsRepo.getClub,
      adjustBalance: clubsRepo.adjustBalance,
      getTeamName: clubsRepo.getTeamName,
      getStadiumState: stadiumRepo.getStadiumState,
      saveStadiumState: stadiumRepo.saveStadiumState,
    });
  } catch (e) {
    console.warn("[wire] stadiumSystem", e.message);
  }

  try {
    socialSystem = require("./socialSystem");
    socialSystem.configure({
      listUsernames: socialRepo.listUsernames,
    });
    socialSystem.seedForumIfEmpty().then(() => {
      console.log("[wire] forum seeded if empty");
    }).catch((e) => console.warn("[wire] forum seed", e.message));
  } catch (e) {
    console.warn("[wire] socialSystem", e.message);
  }

  return {
    clubsRepo,
    youthRepo,
    stadiumRepo,
    trainingRepo,
    socialRepo,
    transferSystem,
    youthSystem,
    trainingSystem,
    stadiumSystem,
    socialSystem,
  };
}

module.exports = { wireAll };
