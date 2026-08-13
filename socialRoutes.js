// ============================================================
// socialRoutes.js — /api/forum, /messages, /notifications (async)
// ============================================================

const express = require("express");
const socialSystem = require("./socialSystem");
const antiCheat = require("./antiCheat");
const managerProfile = require("./managerProfile");

function createSocialRouter(opts) {
  const router = express.Router();
  const getUserId = opts.getUserId;
  const getUsername = opts.getUsername;

  router.get("/forum", async (req, res) => {
    try {
      res.json({ posts: await socialSystem.listForum(50) });
    } catch (e) {
      console.error("[forum GET]", e);
      res.status(500).json({ error: "Forum alınamadı" });
    }
  });

  router.post(
    "/forum",
    antiCheat.rateLimitMiddleware({ max: 10, windowMs: 60000, prefix: "forum" }),
    async (req, res) => {
      try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
        const text = req.body && req.body.text;
        const result = await socialSystem.addForumPost(
          userId,
          getUsername(req),
          text,
        );
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
      } catch (e) {
        console.error("[forum POST]", e);
        res.status(500).json({ error: "Paylaşım başarısız" });
      }
    },
  );


  router.delete("/forum/:id", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      // GÜVENLİK: admin herhangi bir gönderiyi silebilir; admin olmayan bir
      // kullanıcı YALNIZCA kendi gönderisini silebilir (deleteForumPost'a
      // requesterUserId geçilerek DB tarafında zorlanır) — önceden herhangi
      // bir giriş yapmış kullanıcı tüm forum gönderilerini silebiliyordu (IDOR);
      // sonrasında ise hiç kimse (admin hariç) kendi gönderisini bile
      // silemiyordu (client "Sil" butonu her zaman 403 dönüyordu).
      const adminUsername = process.env.ADMIN_USERNAME;
      const uname = (req.user && req.user.username) || "";
      const isRequesterAdmin = !!adminUsername && uname === adminUsername;
      const result = await socialSystem.deleteForumPost(
        req.params.id,
        isRequesterAdmin ? null : userId,
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      console.error("[forum DELETE]", e);
      res.status(500).json({ error: "Silinemedi" });
    }
  });

  router.get("/messages", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const [messages, recipients] = await Promise.all([
        socialSystem.listMessages(userId),
        socialSystem.listRecipients(userId),
      ]);
      res.json({ messages, recipients });
    } catch (e) {
      console.error("[messages GET]", e);
      res.status(500).json({ error: "Mesajlar alınamadı" });
    }
  });

  router.post(
    "/messages",
    antiCheat.rateLimitMiddleware({ max: 20, windowMs: 60000, prefix: "msg" }),
    async (req, res) => {
      try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
        const { toUserId, toUsername, text } = req.body || {};
        const result = await socialSystem.sendMessage(
          userId,
          getUsername(req),
          toUserId,
          toUsername,
          text,
        );
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
      } catch (e) {
        console.error("[messages POST]", e);
        res.status(500).json({ error: "Mesaj gönderilemedi" });
      }
    },
  );

  router.get("/notifications", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const [notifications, unread] = await Promise.all([
        socialSystem.listNotifications(userId),
        socialSystem.unreadCount(userId),
      ]);
      res.json({ notifications, unread });
    } catch (e) {
      console.error("[notifications GET]", e);
      res.status(500).json({ error: "Bildirimler alınamadı" });
    }
  });

  router.post("/notifications/read", async (req, res) => {
    try {
      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ error: "Giriş gerekli" });
      const list = await socialSystem.markNotificationsRead(userId);
      res.json({ notifications: list, unread: 0 });
    } catch (e) {
      console.error("[notifications read]", e);
      res.status(500).json({ error: "İşaretleme başarısız" });
    }
  });


  // GET /api/managers/:username — genel menajer profili (gerçek veri)
  router.get("/managers/:username", async (req, res) => {
    try {
      const username = req.params.username;
      if (!username || !String(username).trim()) {
        return res.status(400).json({ error: "Kullanıcı adı gerekli" });
      }
      const profile = await managerProfile.getByUsername(username);
      if (!profile) {
        return res.status(404).json({ error: "Menajer bulunamadı" });
      }
      res.json({ profile });
    } catch (e) {
      console.error("[managers GET]", e);
      res.status(500).json({ error: "Profil alınamadı" });
    }
  });

  // GET /api/managers?username= — alternatif sorgu
  router.get("/managers", async (req, res) => {
    try {
      const username = (req.query && req.query.username) || "";
      if (!String(username).trim()) {
        return res.status(400).json({ error: "username gerekli" });
      }
      const profile = await managerProfile.getByUsername(username);
      if (!profile) {
        return res.status(404).json({ error: "Menajer bulunamadı" });
      }
      res.json({ profile });
    } catch (e) {
      console.error("[managers query]", e);
      res.status(500).json({ error: "Profil alınamadı" });
    }
  });

  return router;
}

module.exports = { createSocialRouter };
