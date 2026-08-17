// ============================================================
// repos/socialRepo.js — forum, messages, notifications (DB)
// ============================================================

const { query } = require("../db");

async function listUsernames() {
  const { rows } = await query(
    `SELECT u.id AS "userId", u.username
     FROM users u
     WHERE u.is_banned = FALSE
     ORDER BY u.username ASC
     LIMIT 500`,
  );
  return rows;
}

// ---- Forum ----

async function listForum(limit = 50) {
  const { rows } = await query(
    `SELECT id, user_id AS "userId", username AS user, text,
            to_char(created_at, 'DD.MM HH24:MI') AS time,
            EXTRACT(EPOCH FROM created_at)*1000 AS ts
     FROM forum_posts
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return rows;
}

async function addForumPost(userId, username, text) {
  text = String(text || "").trim().slice(0, 200);
  if (!text) return { ok: false, error: "Boş mesaj" };
  if (text.length < 2) return { ok: false, error: "Çok kısa" };

  const { rows } = await query(
    `INSERT INTO forum_posts (user_id, username, text)
     VALUES ($1, $2, $3)
     RETURNING id, user_id AS "userId", username AS user, text,
               to_char(created_at, 'DD.MM HH24:MI') AS time,
               EXTRACT(EPOCH FROM created_at)*1000 AS ts`,
    [userId || null, username || "Menajer", text],
  );
  // trim old
  await query(
    `DELETE FROM forum_posts WHERE id IN (
       SELECT id FROM forum_posts ORDER BY created_at DESC OFFSET 200
     )`,
  );
  const posts = await listForum(50);
  return { ok: true, post: rows[0], posts };
}

async function deleteForumPost(postId, requesterUserId) {
  const id = String(postId || "").trim();
  // UUID veya sayısal id — Number(UUID) NaN olduğu için Sil hep "Geçersiz id" dönüyordu
  if (!id || id === "undefined" || id === "null") {
    return { ok: false, error: "Geçersiz id" };
  }
  // GÜVENLİK: requesterUserId verildiyse (admin olmayan çağrı), yalnızca
  // kendi gönderisini silebilir — IDOR'a geri dönmeden "kendi mesajını sil"
  // özelliğini destekler. requesterUserId null ise (admin çağrısı) herhangi
  // bir gönderi silinebilir.
  const params = [id];
  let sql = `DELETE FROM forum_posts WHERE id = $1`;
  if (requesterUserId) {
    sql += ` AND user_id = $2`;
    params.push(requesterUserId);
  }
  const { rowCount } = await query(sql, params);
  if (!rowCount) return { ok: false, error: "Gönderi bulunamadı ya da size ait değil" };
  const posts = await listForum(50);
  return { ok: true, posts };
}

async function countForum() {

  const { rows } = await query(`SELECT COUNT(*)::int AS c FROM forum_posts`);
  return rows[0].c;
}

async function seedForumIfEmpty() {
  const c = await countForum();
  if (c > 0) return;
  await query(
    `INSERT INTO forum_posts (user_id, username, text, created_at) VALUES
     (NULL, 'Admin', 'Hoş geldiniz! Transfer, stadyum ve altyapı güncellemeleri aktif.', NOW() - INTERVAL '1 hour'),
     (NULL, 'ScoutTR', 'Altyapıdan genç çekmek uzun vadede kazandırıyor.', NOW() - INTERVAL '1 day')`,
  );
}

// ---- Messages ----

async function listMessages(userId) {
  const { rows } = await query(
    `SELECT m.id, m.text,
            m.from_user_id AS "fromUserId",
            m.to_user_id AS "toUserId",
            fu.username AS "fromUsername",
            tu.username AS "toUsername",
            to_char(m.created_at, 'DD.MM HH24:MI') AS time,
            EXTRACT(EPOCH FROM m.created_at)*1000 AS ts,
            COALESCE(m.is_read, FALSE) AS "isRead"
     FROM messages m
     JOIN users fu ON fu.id = m.from_user_id
     JOIN users tu ON tu.id = m.to_user_id
     WHERE m.from_user_id = $1 OR m.to_user_id = $1
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [userId],
  );
  return rows.map((r) => {
    const isOut = String(r.fromUserId) === String(userId);
    return {
      id: r.id,
      from: isOut ? "me" : r.fromUsername,
      fromUserId: r.fromUserId,
      fromUsername: r.fromUsername,
      to: isOut ? r.toUsername : "me",
      toUserId: r.toUserId,
      text: r.text,
      time: r.time,
      ts: Number(r.ts),
      // Giden mesajlar her zaman "okundu" sayılır; gelenlerde DB is_read kullanılır
      read: isOut ? true : !!r.isRead,
    };
  });
}

async function sendMessage(fromUserId, fromUsername, toUserId, toUsername, text) {
  text = String(text || "").trim().slice(0, 200);
  if (!text) return { ok: false, error: "Boş mesaj" };
  if (!toUserId) return { ok: false, error: "Alıcı gerekli" };
  if (String(fromUserId) === String(toUserId))
    return { ok: false, error: "Kendine mesaj atamazsın" };

  const { rows } = await query(
    `INSERT INTO messages (from_user_id, to_user_id, text)
     VALUES ($1, $2, $3)
     RETURNING id, text, created_at`,
    [fromUserId, toUserId, text],
  );
  const row = rows[0];
  // Mesajlar yalnızca mesaj kutusuna gider; bildirim oluşturulmaz.
  const messages = await listMessages(fromUserId);
  return {
    ok: true,
    message: {
      id: row.id,
      from: "me",
      to: toUsername || "?",
      text: row.text,
      time: "Şimdi",
    },
    messages,
  };
}

// ---- Notifications ----

async function listNotifications(userId) {
  // Mesaj bildirimleri mesaj kutusuna aittir; bildirim listesinde gösterilmez.
  const { rows } = await query(
    `SELECT id, icon, text, category AS time, is_read AS read,
            EXTRACT(EPOCH FROM created_at)*1000 AS ts
     FROM notifications
     WHERE user_id = $1
       AND COALESCE(category, '') NOT ILIKE 'mesaj%'
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    icon: r.icon,
    text: r.text,
    time: r.time || "",
    read: r.read,
    ts: Number(r.ts),
  }));
}

async function pushNotification(userId, icon, text, category) {
  if (!userId) return;
  await query(
    `INSERT INTO notifications (user_id, icon, text, category)
     VALUES ($1, $2, $3, $4)`,
    [userId, icon || "🔔", String(text || "").slice(0, 200), category || null],
  );
  await query(
    `DELETE FROM notifications WHERE id IN (
       SELECT id FROM notifications WHERE user_id = $1
       ORDER BY created_at DESC OFFSET 50
     )`,
    [userId],
  );
}

async function markNotificationsRead(userId) {
  await query(
    `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`,
    [userId],
  );
  return listNotifications(userId);
}

async function unreadCount(userId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM notifications
     WHERE user_id = $1 AND is_read = FALSE
       AND COALESCE(category, '') NOT ILIKE 'mesaj%'`,
    [userId],
  );
  return rows[0].c;
}


async function markMessagesRead(userId) {
  if (!userId) return { ok: true, updated: 0 };
  const { rowCount } = await query(
    `UPDATE messages SET is_read = TRUE
     WHERE to_user_id = $1 AND COALESCE(is_read, FALSE) = FALSE`,
    [userId],
  );
  return { ok: true, updated: rowCount || 0 };
}

async function messagesUnreadCount(userId) {
  if (!userId) return 0;
  const { rows } = await query(
    `SELECT COUNT(*)::int AS c FROM messages
     WHERE to_user_id = $1 AND COALESCE(is_read, FALSE) = FALSE`,
    [userId],
  );
  return rows[0] ? rows[0].c : 0;
}

module.exports = {
  deleteForumPost,
  listUsernames,
  listForum,
  addForumPost,
  seedForumIfEmpty,
  listMessages,
  sendMessage,
  markMessagesRead,
  messagesUnreadCount,
  listNotifications,
  pushNotification,
  markNotificationsRead,
  unreadCount,
};

