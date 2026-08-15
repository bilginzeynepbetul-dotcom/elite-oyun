// ============================================================
// socialSystem.js — forum / mesaj / bildirim sarmalayıcı
// ============================================================

const socialRepo = require("./repos/socialRepo");

async function pushNotification(userId, icon, text, category) {
  return socialRepo.pushNotification(userId, icon, text, category);
}

async function listNotifications(userId) {
  return socialRepo.listNotifications(userId);
}

async function markRead(userId) {
  return socialRepo.markNotificationsRead(userId);
}

async function unreadCount(userId) {
  return socialRepo.unreadCount(userId);
}

async function listForum(limit) {
  return socialRepo.listForum(limit);
}

async function addForumPost(userId, username, text) {
  return socialRepo.addForumPost(userId, username, text);
}

async function deleteForumPost(postId, requesterUserId) {
  return socialRepo.deleteForumPost(postId, requesterUserId);
}

async function listMessages(userId) {
  return socialRepo.listMessages(userId);
}

async function sendMessage(fromUserId, fromUsername, toUserId, toUsername, text) {
  return socialRepo.sendMessage(
    fromUserId,
    fromUsername,
    toUserId,
    toUsername,
    text,
  );
}

async function listUsernames() {
  return socialRepo.listUsernames();
}

async function seedForumIfEmpty() {
  return socialRepo.seedForumIfEmpty();
}

/** Maç sonucu bildirimi (matchLifecycle) */
async function notifyMatchResult(userId, text) {
  if (!userId) return;
  return pushNotification(userId, "⚽", text, "maç");
}

module.exports = {
  pushNotification,
  listNotifications,
  markRead,
  unreadCount,
  listForum,
  addForumPost,
  deleteForumPost,
  listMessages,
  sendMessage,
  listUsernames,
  seedForumIfEmpty,
  notifyMatchResult,
};
