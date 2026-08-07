const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    // Validasyon
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Tüm alanlar gerekli' });
    }
    
    // Kullanıcı var mı kontrol et
    const existingUser = await db.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Kullanıcı adı veya email zaten kullanımda' });
    }
    
    // Şifreyi hash'le
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Kullanıcıyı oluştur
    const result = await db.query(
      `INSERT INTO users (username, email, password) 
       VALUES ($1, $2, $3) 
       RETURNING id, username, email, created_at`,
      [username, email, hashedPassword]
    );
    
    const newUser = result.rows[0];
    
    // Token oluştur
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.status(201).json({
      success: true,
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        created_at: newUser.created_at
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Kayıt işlemi başarısız' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Kullanıcı adı ve şifre gerekli' });
    }
    
    // Kullanıcıyı bul
    const result = await db.query(
      `SELECT id, username, email, password, banned_until, ban_reason 
       FROM users 
       WHERE username = $1 OR email = $1`,
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Geçersiz kullanıcı adı veya şifre' });
    }
    
    const user = result.rows[0];
    
    // Şifre kontrolü
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Geçersiz kullanıcı adı veya şifre' });
    }
    
    // 🔥 BAN KONTROLÜ - EKLENEN KISIM
    if (user.banned_until && new Date() < new Date(user.banned_until)) {
      return res.status(403).json({
        error: 'Hesabınız geçici olarak engellenmiştir',
        code: 'BANNED',
        reason: user.ban_reason || 'Kural ihlali',
        banned_until: user.banned_until,
        remaining_hours: Math.ceil((new Date(user.banned_until) - new Date()) / (1000 * 60 * 60))
      });
    }
    
    // Ban süresi dolmuşsa otomatik kaldır
    if (user.banned_until && new Date() >= new Date(user.banned_until)) {
      await db.query(
        'UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1',
        [user.id]
      );
    }
    // 🔥 BAN KONTROLÜ SONU
    
    // Token oluştur
    const token = jwt.sign(
      { id: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        elite_plan: user.elite_plan,
        elite_until: user.elite_until
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Giriş işlemi başarısız' });
  }
});

// Me (token ile kullanıcı bilgisi)
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token gerekli' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    const result = await db.query(
      `SELECT id, username, email, elite_plan, elite_until, banned_until, ban_reason, created_at 
       FROM users 
       WHERE id = $1`,
      [decoded.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    const user = result.rows[0];
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        elite_plan: user.elite_plan,
        elite_until: user.elite_until,
        banned_until: user.banned_until,
        ban_reason: user.ban_reason,
        created_at: user.created_at
      }
    });
  } catch (error) {
    console.error('Me error:', error);
    res.status(401).json({ error: 'Geçersiz token' });
  }
});

module.exports = router;
