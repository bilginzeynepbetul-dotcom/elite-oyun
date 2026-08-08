const express = require('express');
const router = express.Router();
const db = require('./db');
const { isAdmin } = require('./authMiddleware');

// Kullanıcının ban durumunu döner (routes/authRoutes.js authMiddleware bunu her istekte çağırır)
async function getBanStatus(userId) {
  try {
    const result = await db.query(
      'SELECT is_banned, banned_until, ban_reason FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) return { banned: false };
    const { is_banned, banned_until, ban_reason } = result.rows[0];

    if (banned_until && new Date() >= new Date(banned_until)) {
      // Süre dolmuş, otomatik kaldır
      await db.query(
        'UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL WHERE id = $1',
        [userId]
      );
      return { banned: false };
    }

    if (is_banned || (banned_until && new Date() < new Date(banned_until))) {
      return { banned: true, reason: ban_reason, until: banned_until };
    }
    return { banned: false };
  } catch (error) {
    console.error('getBanStatus error:', error);
    return { banned: false };
  }
}

// Ban listesi ve özet
router.get('/summary', isAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        u.id, 
        u.username, 
        u.banned_until,
        u.ban_reason,
        COUNT(al.id) as log_count
      FROM users u
      LEFT JOIN anti_cheat_log al ON u.id = al.user_id
      WHERE u.banned_until IS NOT NULL
      GROUP BY u.id, u.username, u.banned_until, u.ban_reason
      ORDER BY u.banned_until DESC
    `);
    
    res.json({
      banned_users: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    console.error('Ban summary error:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// Ban at
router.post('/ban', isAdmin, async (req, res) => {
  const { target, reason, hours = 24 } = req.body;
  const adminId = req.user.id;
  
  try {
    // Hedef kullanıcıyı bul
    const userResult = await db.query(
      'SELECT id, username FROM users WHERE username = $1 OR id = $1',
      [target]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    const targetUser = userResult.rows[0];
    const bannedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    
    // Ban ekle
    await db.query(
      'UPDATE users SET banned_until = $1, ban_reason = $2 WHERE id = $3',
      [bannedUntil, reason || 'Kural ihlali', targetUser.id]
    );
    
    // Anti-cheat log'u ekle
    await db.query(
      `INSERT INTO anti_cheat_log 
       (user_id, action, reason, admin_id, details) 
       VALUES ($1, $2, $3, $4, $5)`,
      [
        targetUser.id,
        'admin_ban',
        reason || 'Kural ihlali',
        adminId,
        JSON.stringify({ hours, banned_until: bannedUntil })
      ]
    );
    
    res.json({
      success: true,
      message: `${targetUser.username} ${hours} saat banlandı`,
      banned_until: bannedUntil
    });
  } catch (error) {
    console.error('Ban error:', error);
    res.status(500).json({ error: 'Ban işlemi başarısız' });
  }
});

// Ban kaldır
router.post('/unban', isAdmin, async (req, res) => {
  const { target } = req.body;
  const adminId = req.user.id;
  
  try {
    const userResult = await db.query(
      'SELECT id, username FROM users WHERE username = $1 OR id = $1',
      [target]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    const targetUser = userResult.rows[0];
    
    // Ban kaldır
    await db.query(
      'UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1',
      [targetUser.id]
    );
    
    // Anti-cheat log'u ekle
    await db.query(
      `INSERT INTO anti_cheat_log 
       (user_id, action, reason, admin_id) 
       VALUES ($1, $2, $3, $4)`,
      [
        targetUser.id,
        'admin_unban',
        'Admin tarafından kaldırıldı',
        adminId
      ]
    );
    
    res.json({
      success: true,
      message: `${targetUser.username} banı kaldırıldı`
    });
  } catch (error) {
    console.error('Unban error:', error);
    res.status(500).json({ error: 'Ban kaldırma işlemi başarısız' });
  }
});

// Anti-cheat logları
router.get('/logs', isAdmin, async (req, res) => {
  const { limit = 100, offset = 0 } = req.query;
  
  try {
    const result = await db.query(
      `SELECT 
        al.*,
        u.username as user_name,
        a.username as admin_name
      FROM anti_cheat_log al
      LEFT JOIN users u ON al.user_id = u.id
      LEFT JOIN users a ON al.admin_id = a.id
      ORDER BY al.created_at DESC
      LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );
    
    const countResult = await db.query('SELECT COUNT(*) FROM anti_cheat_log');
    
    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].count)
    });
  } catch (error) {
    console.error('Log error:', error);
    res.status(500).json({ error: 'Loglar alınamadı' });
  }
});

// Kullanıcı ban durumunu kontrol et
router.get('/status/:userId', isAdmin, async (req, res) => {
  const { userId } = req.params;
  
  try {
    const result = await db.query(
      'SELECT banned_until, ban_reason FROM users WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    const { banned_until, ban_reason } = result.rows[0];
    
    res.json({
      is_banned: banned_until !== null && new Date() < new Date(banned_until),
      banned_until: banned_until,
      ban_reason: ban_reason
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Durum kontrolü hatası' });
  }
});

module.exports = router;
module.exports.getBanStatus = getBanStatus;
