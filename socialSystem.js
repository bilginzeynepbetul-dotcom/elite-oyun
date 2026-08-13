// ============================================================
// socialSystem.js — Forum / mesaj / bildirim (DB-backed)
// ------------------------------------------------------------
// configure opsiyonel; asıl iş repos/socialRepo.js
// Eski in-memory API korunur (async).
// ============================================================

const socialRepo = require("./repos/socialRepo");

let deps = {
  listUsernames: null,
  log: console.log,
};

function configure(next) {
  deps = Object.assign(deps, next || {});
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

async function listRecipients(excludeUserId) {
  let rows;
  if (typeof deps.listUsernames === "function") {
    rows = await Promise.resolve(deps.listUsernames());
  } else {
    rows = await socialRepo.listUsernames();
  }
  return (rows || [])
    .filter((u) => String(u.userId) !== String(excludeUserId))
    .map((u) => ({ userId: u.userId, username: u.username }));
}

async function listNotifications(userId) {
  return socialRepo.listNotifications(userId);
}

async function pushNotification(userId, icon, text, category) {
  return socialRepo.pushNotification(userId, icon, text, category);
}

async function markNotificationsRead(userId) {
  return socialRepo.markNotificationsRead(userId);
}

async function unreadCount(userId) {
  return socialRepo.unreadCount(userId);
}

async function seedForumIfEmpty() {
  return socialRepo.seedForumIfEmpty();
}

module.exports = {
  configure,
  listForum,
  addForumPost,
  deleteForumPost,
  listMessages,
  sendMessage,
  listRecipients,
  listNotifications,
  pushNotification,
  markNotificationsRead,
  unreadCount,
  seedForumIfEmpty,
};
