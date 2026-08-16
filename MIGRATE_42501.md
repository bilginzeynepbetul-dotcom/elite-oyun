# Migrate 42501 — yetki hatası

`code: '42501'` = **insufficient_privilege**. Kod tarafı (pgcrypto / IF NOT EXISTS) düzeltildi; bu hata artık neredeyse her zaman **yanlış veya kısıtlı DATABASE_URL** demektir.

## Teşhis

```bash
npm run migrate
```

Çıktıda şunu görürsün:

```
[migrate] hedef: user@host:port/dbname
[migrate] bağlantı: user=... db=... CREATE=false   ← sorun burada
```

`CREATE=false` ise migration **bilerek** durur; tablo oluşturamaz.

## Platforma göre çözüm

### Render
1. Dashboard → PostgreSQL servisin → **Connect**
2. **Internal Database URL** (aynı hesapta web servisi) veya **External** kopyala
3. Web servisi → Environment → `DATABASE_URL` = bu URL
4. **Owner** kullanıcı olmalı (Render’ın verdiği varsayılan URL genelde yeter)

### Supabase
1. Project Settings → **Database** → Connection string → **URI**
2. `[YOUR-PASSWORD]` yerine gerçek DB şifresini yaz
3. **Session mode** tercih et (`db.xxx.supabase.co:5432`)
4. Transaction pooler (`:6543`, `?pgbouncer=true`) ile DDL (CREATE TABLE) bazen yetki/uyumluluk sorunu çıkarır → migrate için **5432 session**

### Yerel Docker
```bash
docker compose up -d db
# .env:
DATABASE_URL=postgres://em:em@localhost:5432/elite_manager
npm run migrate
```

### Genel kontrol
- Read-only / replica URL kullanma
- “Viewer” / “read-only” role kullanma
- URL’de doğru **database adı** olsun (boş veya yanlış DB’ye bağlanınca public şemada CREATE kapalı olabilir)

## Hâlâ olursa (manuel)

Postgres shell’de (süperuser veya owner ile):

```sql
SELECT current_user, current_database(),
       has_database_privilege(current_user, current_database(), 'CREATE');
-- true olmalı

-- Gerekirse (owner olarak):
GRANT CREATE ON DATABASE your_db TO your_user;
GRANT ALL ON SCHEMA public TO your_user;
```

Supabase/Render’da genelde **doğru connection string** yeter; ekstra GRANT gerekmez.
