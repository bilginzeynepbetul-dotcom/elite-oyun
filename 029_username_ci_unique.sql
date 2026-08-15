-- ============================================================
-- 029_username_ci_unique.sql
-- ------------------------------------------------------------
-- GÜVENLİK: users.username üzerindeki eski kısıt (uq_users_username)
-- case-sensitive'di ("admin" ile "Admin" ayrı kabul ediliyordu).
-- authMiddleware.isAdmin ise case-insensitive karşılaştırma yapıyor
-- (LOWER(username) === LOWER(ADMIN_USERNAME)). Aradaki bu fark,
-- eşzamanlı iki kayıt isteğinde ("admin" + "Admin") ikisinin de
-- application-level SELECT kontrolünü (race condition ile) geçip
-- ayrı satır olarak INSERT edilebilmesine — yani gerçek admin'in
-- yanında farklı case'li bir hesabın da admin yetkisi kazanmasına
-- yol açabiliyordu. Bunu DB seviyesinde, gerçek bir case-insensitive
-- UNIQUE index ile kapatıyoruz (artık SELECT + INSERT arasında yarış
-- olsa bile Postgres ikinci INSERT'i reddeder).
-- ============================================================

DO $$
DECLARE
  dup RECORD;
  n INT;
BEGIN
  -- Aynı lower(username)'a sahip birden fazla kayıt varsa (bu migration'dan
  -- önceki race condition sonucu oluşmuş olabilir), en eski kaydı bırakıp
  -- diğerlerini benzersiz bir son ek ile yeniden adlandır — aksi halde
  -- aşağıdaki UNIQUE index oluşturma adımı "duplicate key" hatasıyla düşer
  -- ve deploy'u bloke eder.
  FOR dup IN
    SELECT LOWER(username) AS lu, COUNT(*) AS c
    FROM users
    GROUP BY LOWER(username)
    HAVING COUNT(*) > 1
  LOOP
    n := 0;
    -- En eski (created_at) satır orijinal adını korur; sonrakiler yeniden adlandırılır.
    UPDATE users u
    SET username = u.username || '_dup' || sub.rn
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY LOWER(username) ORDER BY created_at ASC) - 1 AS rn
      FROM users
      WHERE LOWER(username) = dup.lu
    ) sub
    WHERE u.id = sub.id AND sub.rn > 0;
  END LOOP;
END $$;

-- Eski case-sensitive kısıtı kaldır (artık aşağıdaki case-insensitive index onun yerini alıyor)
ALTER TABLE users DROP CONSTRAINT IF EXISTS uq_users_username;

-- Eski (unique olmayan) lower(username) index'i, unique olanla çakışmasın diye kaldır
DROP INDEX IF EXISTS idx_users_username_lower;

-- Gerçek case-insensitive benzersizlik — artık DB seviyesinde garanti
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username_lower ON users (LOWER(username));
