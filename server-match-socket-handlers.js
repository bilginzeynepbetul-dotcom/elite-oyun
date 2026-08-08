// ============================================================
// server-match-socket-handlers.js
// ------------------------------------------------------------
// matchEngine.Match üzerindeki applyTacticChange / applySubstitution
// metodlarını socket.io event'lerine bağlar.
//
// KULLANIM: Ana sunucu dosyanda (ör. server.js / socket.js) io
// bağlantısı kurulduktan sonra registerMatchControlHandlers(io, getMatchByFixture)
// çağır.
//
// getMatchByFixture(fixtureId) → canlı Match instance veya null dönmeli.
// İstemci event'leri:
//   match:tactics  { fixtureId, side, tactics: {passStyle,gameStyle,attackDir} }
//   match:sub      { fixtureId, side, outIdx, inIdx }
// Sunucu cevapları:
//   match:tactics:result  { ok, error? }
//   match:sub:result      { ok, error?, out?, in?, subsLeft? }
//   (+ başarılı olursa match:state / match:log zaten Match.broadcast ile gider)
// ============================================================

/**
 * @param {import("socket.io").Server} io
 * @param {(fixtureId: string) => any} getMatchByFixture
 *   fixtureId → Match instance (veya null)
 * @param {(socket) => {id?: string, clubId?: string}|null} [getSocketIdentity]
 *   socket'ten user kimliği; side doğrulaması için zorunlu
 */
function registerMatchControlHandlers(io, getMatchByFixture, getSocketIdentity) {
  io.on("connection", (socket) => {
    socket.on("match:tactics", (payload) => {
      try {
        const { fixtureId, side, tactics } = payload || {};
        const match = getMatchByFixture(fixtureId);
        if (!match) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Maç bulunamadı",
          });
          return;
        }
        if (match.status !== "live") {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Maç canlı değil",
          });
          return;
        }
        // Sadece kendi tarafını değiştirebilsin. Bot/rakip tarafına müdahale engellenir.
        if (typeof getSocketIdentity !== "function") {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Yetki doğrulanamadı",
          });
          return;
        }
        const ident = getSocketIdentity(socket);
        if (!ident || !ident.id) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Yetki doğrulanamadı",
          });
          return;
        }
        if (side !== "home" && side !== "away") {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Geçersiz taraf",
          });
          return;
        }
        const sidePlayer = match.players[side];
        if (
          !sidePlayer ||
          !sidePlayer.userId ||
          String(sidePlayer.userId) !== String(ident.id)
        ) {
          socket.emit("match:tactics:result", {
            ok: false,
            error: "Bu taraf size ait değil",
          });
          return;
        }
        const result = match.applyTacticChange(side, tactics || {});
        socket.emit("match:tactics:result", result || { ok: true });
      } catch (e) {
        console.error("[match:tactics]", e);
        socket.emit("match:tactics:result", {
          ok: false,
          error: "Sunucu hatası",
        });
      }
    });

    socket.on("match:sub", (payload) => {
      try {
        const { fixtureId, side, outIdx, inIdx } = payload || {};
        const match = getMatchByFixture(fixtureId);
        if (!match) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Maç bulunamadı",
          });
          return;
        }
        if (match.status !== "live") {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Maç canlı değil",
          });
          return;
        }
        if (typeof getSocketIdentity !== "function") {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Yetki doğrulanamadı",
          });
          return;
        }
        const ident = getSocketIdentity(socket);
        if (!ident || !ident.id) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Yetki doğrulanamadı",
          });
          return;
        }
        if (side !== "home" && side !== "away") {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Geçersiz taraf",
          });
          return;
        }
        const sidePlayer = match.players[side];
        if (
          !sidePlayer ||
          !sidePlayer.userId ||
          String(sidePlayer.userId) !== String(ident.id)
        ) {
          socket.emit("match:sub:result", {
            ok: false,
            error: "Bu taraf size ait değil",
          });
          return;
        }
        const result = match.applySubstitution(side, outIdx, inIdx);
        socket.emit("match:sub:result", result || { ok: false, error: "?" });
      } catch (e) {
        console.error("[match:sub]", e);
        socket.emit("match:sub:result", {
          ok: false,
          error: "Sunucu hatası",
        });
      }
    });
  });
}

module.exports = { registerMatchControlHandlers };
