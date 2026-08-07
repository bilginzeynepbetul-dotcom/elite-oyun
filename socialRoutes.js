// ============================================================
// socialRoutes.js — /api/forum, /messages, /notifications (async)
// ============================================================

const express = require("express");
const socialSystem = require("./socialSystem");

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

  router.post("/forum", async (req, res) => {
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

  router.post("/messages", async (req, res) => {
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
  });

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

  return router;
}

module.exports = { createSocialRouter };
