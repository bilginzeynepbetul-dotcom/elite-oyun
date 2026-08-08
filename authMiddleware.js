const jwt = require('jsonwebtoken');
const db = require('./db');

// GÜVENLİK: sabit/varsayılan bir JWT secret ile prod'a çıkmak, bu dosyayı
// gören (repo erişimi olan) herkesin istediği kullanıcı/admin adına geçerli
// token üretebilmesi demektir. Bu yüzden burada asla hardcoded bir fallback
// kullanılmaz; env değişkeni yoksa uygulama güvenli şekilde başlamayı reddeder.
// (routes/authRoutes.js ile aynı politika.)
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET ortam değişkeni tanımlı değil. Güvenlik nedeniyle sabit bir ' +
      'varsayılan secret KULLANILMIYOR — lütfen .env dosyasına güçlü, rastgele ' +
      'bir JWT_SECRET ekleyin (ör. `openssl rand -hex 32`).',
  );
}

// Ban kontrolü
const checkBanStatus = async (userId) => {
  const result = await db.query(
    'SELECT banned_until, ban_reason FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) return null;
  
  const { banned_until, ban_reason } = result.rows[0];
  if (!banned_until) return null;
  
  // Ban süresi dolmuş mu kontrol et
  if (new Date() > new Date(banned_until)) {
    // Ban süresi doldu, otomatik kaldır
    await db.query(
      'UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE id = $1',
      [userId]
    );
    return null;
  }
  
  return { banned_until, ban_reason };
};

// Ana auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token gerekli' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Kullanıcıyı kontrol et
    const userResult = await db.query(
      'SELECT id, username, email, banned_until, ban_reason FROM users WHERE id = $1',
      [decoded.id]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    }
    
    const user = userResult.rows[0];
    
    // Ban kontrolü
    const banStatus = await checkBanStatus(user.id);
    if (banStatus) {
      return res.status(403).json({
        error: 'Hesabınız geçici olarak engellenmiştir',
        code: 'BANNED',
        banned_until: banStatus.banned_until,
        reason: banStatus.ban_reason
      });
    }
    
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(401).json({ error: 'Geçersiz token' });
  }
};

// Admin kontrolü
const isAdmin = async (req, res, next) => {
  try {
    const adminUsername = process.env.ADMIN_USERNAME;
    
    if (!adminUsername) {
      console.error('ADMIN_USERNAME env ayarlanmamış');
      return res.status(403).json({ error: 'Admin yetkisi gerekli' });
    }
    
    if (req.user.username !== adminUsername) {
      return res.status(403).json({ error: 'Admin yetkisi gerekli' });
    }
    
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Yetki kontrolü hatası' });
  }
};

module.exports = { authMiddleware, isAdmin, checkBanStatus };
