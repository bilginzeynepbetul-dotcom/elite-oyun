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

// Ban kontrolü — is_banned + banned_until uyumlu (adminAntiCheatRoutes.getBanStatus ile aynı mantık)
const checkBanStatus = async (userId) => {
  const result = await db.query(
    'SELECT is_banned, banned_until, ban_reason FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) return null;

  const { is_banned, banned_until, ban_reason } = result.rows[0];

  // Süre dolmuşsa otomatik kaldır
  if (banned_until && new Date() >= new Date(banned_until)) {
    await db.query(
      'UPDATE users SET is_banned = FALSE, banned_until = NULL, ban_reason = NULL WHERE id = $1',
      [userId]
    );
    return null;
  }

  if (is_banned || (banned_until && new Date() < new Date(banned_until))) {
    return { banned_until, ban_reason };
  }

  return null;
};

// Ana auth middleware
// Token payload: { sub, username, clubId } (routes/authRoutes.js signToken)
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token gerekli' });
    }

    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.typ === 'refresh') {
      return res.status(401).json({
        error: 'Access token gerekli',
        code: 'ACCESS_REQUIRED',
      });
    }
    // JWT standardı: kullanıcı id'si "sub" alanında
    const userId = decoded.sub || decoded.id;
    if (!userId) {
      return res.status(401).json({ error: 'Geçersiz token' });
    }

    // Kullanıcıyı kontrol et (+ token_version)
    const userResult = await db.query(
      `SELECT id, username, email, is_banned, banned_until, ban_reason,
              deleted_at, COALESCE(token_version, 0) AS token_version
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Kullanıcı bulunamadı' });
    }

    const user = userResult.rows[0];

    if (user.deleted_at) {
      return res.status(401).json({
        error: 'Bu hesap kapatılmış',
        code: 'ACCOUNT_DELETED',
      });
    }

    // Oturum iptali: şifre sıfırlama / logout-all / ban sonrası eski JWT düşer
    const tv = Number(user.token_version) || 0;
    if (decoded.tv == null || Number(decoded.tv) !== tv) {
      return res.status(401).json({
        error: 'Oturum iptal edilmiş, tekrar giriş yapın',
        code: 'TOKEN_REVOKED',
      });
    }

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

    req.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      clubId: decoded.clubId || null,
      tokenVersion: tv,
    };
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

    // nationalSystem.isAdmin ile aynı politika: case-insensitive
    if (
      !req.user ||
      !req.user.username ||
      String(req.user.username).toLowerCase() !==
        String(adminUsername).toLowerCase()
    ) {
      return res.status(403).json({ error: 'Admin yetkisi gerekli' });
    }

    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Yetki kontrolü hatası' });
  }
};

module.exports = { authMiddleware, isAdmin, checkBanStatus };
