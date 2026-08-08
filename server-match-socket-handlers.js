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
 * @param {(socket) => {userId?: string, clubId?: string}|null} [getSocketIdentity]
 *   opsiyonel: socket'ten user/club kimliği; side doğrulaması için
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
        // İsteğe bağlı yetki: sadece kendi tarafını değiştirebilsin
        if (typeof getSocketIdentity === "function") {
          const ident = getSocketIdentity(socket);
          // GÜVENLİK: getSocketIdentity, routes/authRoutes.js socketAuthMiddleware
          // tarafından ayarlanan socket.data.user'ı döner ve bu nesnenin alanı
          // "id"dir ("userId" değil). Önceden "ident.userId" kontrol edildiği için
          // bu ifade her zaman undefined dönüyor ve sahiplik kontrolü hiç
          // çalışmıyordu — böylece herhangi bir oturum açmış kullanıcı, canlı bir
          // maçın HERHANGİ bir tarafının taktiğini değiştirebiliyordu.
          if (ident && ident.id) {
            const sidePlayer = match.players[side];
            if (
              sidePlayer &&
              sidePlayer.userId &&
              String(sidePlayer.userId) !== String(ident.id) &&
              !sidePlayer.isBot
            ) {
              socket.emit("match:tactics:result", {
                ok: false,
                error: "Bu taraf size ait değil",
              });
              return;
            }
          }
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
        if (typeof getSocketIdentity === "function") {
          const ident = getSocketIdentity(socket);
          // GÜVENLİK: bkz. yukarıdaki match:tactics açıklaması — alan adı "id"
          // olmalı, "userId" değil; aksi halde sahiplik kontrolü atlanır.
          if (ident && ident.id) {
            const sidePlayer = match.players[side];
            if (
              sidePlayer &&
              sidePlayer.userId &&
              String(sidePlayer.userId) !== String(ident.id) &&
              !sidePlayer.isBot
            ) {
              socket.emit("match:sub:result", {
                ok: false,
                error: "Bu taraf size ait değil",
              });
              return;
            }
          }
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
