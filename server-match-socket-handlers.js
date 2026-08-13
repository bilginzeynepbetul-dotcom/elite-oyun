// ============================================================
// server-match-socket-handlers.js
// Canlı maç kontrolü: taktik değişikliği + oyuncu değişikliği
// (match:tactics / match:sub) ve taraf çözümü (resolveSideForUser).
// ============================================================

/**
 * Kullanıcının maçtaki tarafını (home | away | null) bulur.
 * Önce userId, yoksa clubId ile eşleştirir.
 * @param {object} match  Match instance (players.home / players.away)
 * @param {string|number|null} userId
 * @returns {"home"|"away"|null}
 */
function resolveSideForUser(match, userId) {
  if (!match || !match.players) return null;
  const uid = userId != null ? String(userId) : null;
  if (!uid) return null;

  const home = match.players.home;
  const away = match.players.away;

  if (home && home.userId != null && String(home.userId) === uid) return "home";
  if (away && away.userId != null && String(away.userId) === uid) return "away";

  return null;
}

/**
 * clubId üzerinden taraf çöz (userId yoksa veya bot-owned olmayan kulüpler için).
 */
function resolveSideForClub(match, clubId) {
  if (!match || !match.players || clubId == null) return null;
  const cid = String(clubId);
  const home = match.players.home;
  const away = match.players.away;
  if (home && home.clubId != null && String(home.clubId) === cid) return "home";
  if (away && away.clubId != null && String(away.clubId) === cid) return "away";
  return null;
}

/**
 * Socket.IO bağlantısına maç kontrol event'lerini kaydeder.
 *
 * @param {import('socket.io').Server} io
 * @param {(fixtureId: string) => object|null} getMatch  liveMatches.get(fixtureId)
 * @param {(socket) => {id, username, clubId}|null} getUser  socket.data.user
 */
function registerMatchControlHandlers(io, getMatch, getUser) {
  if (!io) return;

  io.on("connection", (socket) => {
    // --------------------------------------------------------
    // match:tactics  { fixtureId, side?, tactics }
    // --------------------------------------------------------
    socket.on("match:tactics", (payload) => {
      try {
        const user = typeof getUser === "function" ? getUser(socket) : null;
        if (!user || !user.id) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Oturum gerekli",
          });
          return;
        }

        const fixtureId =
          payload && (payload.fixtureId || payload.matchId || payload.id);
        if (!fixtureId) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "fixtureId gerekli",
          });
          return;
        }

        const match = typeof getMatch === "function" ? getMatch(fixtureId) : null;
        if (!match) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Maç bulunamadı veya henüz canlı değil",
            fixtureId,
          });
          return;
        }

        if (match.status !== "live" && match.status !== "countdown") {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Maç canlı değil",
            fixtureId,
          });
          return;
        }

        const owned =
          resolveSideForUser(match, user.id) ||
          resolveSideForClub(match, user.clubId);

        if (!owned) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Bu maçta bir tarafa sahip değilsin",
            fixtureId,
          });
          return;
        }

        // İstemci side gönderdiyse doğrula (spoof koruması)
        if (
          (payload.side === "home" || payload.side === "away") &&
          payload.side !== owned
        ) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Bu tarafa yetkin yok",
            fixtureId,
          });
          return;
        }

        const side = owned;

        if (typeof match.applyTacticChange !== "function") {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Taktik değişikliği desteklenmiyor",
            fixtureId,
          });
          return;
        }

        const result = match.applyTacticChange(side, (payload && payload.tactics) || {});
        socket.emit("match:tactics:result", {
          ...result,
          fixtureId,
          side,
        });
      } catch (e) {
        console.error("[match:tactics]", e);
        socket.emit("match:tactics:result", {
          ok: false,
          error: e.message || "Taktik uygulanamadı",
        });
      }
    });

    // --------------------------------------------------------
    // match:sub  { fixtureId, side?, outIdx, inIdx }
    // --------------------------------------------------------
    socket.on("match:sub", (payload) => {
      try {
        const user = typeof getUser === "function" ? getUser(socket) : null;
        if (!user || !user.id) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Oturum gerekli",
          });
          return;
        }

        const fixtureId =
          payload && (payload.fixtureId || payload.matchId || payload.id);
        if (!fixtureId) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "fixtureId gerekli",
          });
          return;
        }

        const match = typeof getMatch === "function" ? getMatch(fixtureId) : null;
        if (!match) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Maç bulunamadı veya henüz canlı değil",
            fixtureId,
          });
          return;
        }

        if (match.status !== "live" && match.status !== "countdown") {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Maç canlı değil",
            fixtureId,
          });
          return;
        }

        const owned =
          resolveSideForUser(match, user.id) ||
          resolveSideForClub(match, user.clubId);

        if (!owned) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Bu maçta bir tarafa sahip değilsin",
            fixtureId,
          });
          return;
        }

        if (
          (payload.side === "home" || payload.side === "away") &&
          payload.side !== owned
        ) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Bu tarafa yetkin yok",
            fixtureId,
          });
          return;
        }

        const side = owned;

        const outIdx = Number(payload && payload.outIdx);
        const inIdx = Number(payload && payload.inIdx);
        if (!Number.isFinite(outIdx) || !Number.isFinite(inIdx)) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "outIdx / inIdx gerekli",
            fixtureId,
          });
          return;
        }

        if (typeof match.applySubstitution !== "function") {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Değişiklik desteklenmiyor",
            fixtureId,
          });
          return;
        }

        const result = match.applySubstitution(side, outIdx, inIdx);
        socket.emit("match:sub:result", {
          ...result,
          fixtureId,
          side,
        });
      } catch (e) {
        console.error("[match:sub]", e);
        socket.emit("match:sub:result", {
          ok: false,
          error: e.message || "Değişiklik uygulanamadı",
        });
      }
    });
  });
}

module.exports = {
  registerMatchControlHandlers,
  resolveSideForUser,
  resolveSideForClub,
};
