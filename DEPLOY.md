# Canlıya alma

Tam kontrol listesi: **[PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md)** (HTTPS, secret rotasyonu, monitoring, yedek).


## Env (Render Dashboard) — zorunlu

| Key | Değer |
|-----|--------|
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | İlk kayıt olacağın kullanıcı adı |
| `CORS_ORIGIN` | `https://SENIN-SERVIS.onrender.com` |
| `ELITE_ALLOW_MOCK` | `0` |
| `DATABASE_URL` | Otomatik (DB’den) |
| `JWT_SECRET` | Otomatik / `openssl rand -hex 32` |
| `PUBLIC_URL` | Aynı https URL (önerilir) |
| `DONATION_IBAN` + `DONATION_IBAN_NAME` | Gerçek IBAN |

Boş `CORS_ORIGIN` / `ADMIN_USERNAME` / `DATABASE_URL` veya `ELITE_ALLOW_MOCK=1` → production **başlamaz**.

---

## Deploy öncesi (kod tarafı — bir kerelik)

1. Yerelde `npm install` çalıştırıp oluşan `package-lock.json`'ı repoya commit edin
   (reproducible build için — Dockerfile lockfile varsa otomatik `npm ci` kullanır).
2. `.env` dosyanızın gerçekten commit edilmediğini doğrulayın (`.gitignore` artık bunu engeller).

## Deploy sonrası

1. `/healthz` → `ok` + `db: up`
2. Site açılsın
3. `ADMIN_USERNAME` ile kayıt (şifre ≥ 8)
4. Giriş → sonraki maç dolu mu
5. Kadro / forum / Destek Ol IBAN
6. Admin menü çalışıyor mu

---

## Not

- Sonraki maç rakip isimleri her DB’de farklıdır (normal).
- Kod tarafı canlıya hazır; sende kalan sadece Dashboard env + ilk kayıt.
- Rate limiting ve anti-cheat sayaçları process belleğinde tutulur (tek instance
  varsayımıyla). Render’da birden fazla instance/otomatik ölçeklendirme açarsanız
  bu sayaçlar instance’lar arasında paylaşılmaz — o noktada Redis tabanlı bir
  limiter’a geçmek gerekir. Tek instance (free/starter plan) için sorun yok.


## Veri saklama temizliği (KVKK)

Süresi dolmuş e-posta doğrulama token’ları ve eski loglar:

```bash
npm run retention:dry   # ne silineceğini göster
npm run retention       # uygula
```

Cron / Render Cron Job önerisi: haftada bir `npm run retention`.

Opsiyonel admin API: `POST /api/admin/retention-run` body `{ "dryRun": true }`.

| Env | Varsayılan | Anlam |
|-----|------------|--------|
| `RETENTION_ANTI_CHEAT_DAYS` | 90 | anti_cheat_log |
| `RETENTION_ADMIN_AUDIT_DAYS` | 365 | admin_audit_log |
| `RETENTION_ACCOUNT_DELETION_LOG_DAYS` | 730 | account_deletion_log |
| `RETENTION_CLEAR_EXPIRED_EMAIL_TOKENS` | 1 | süresi geçmiş verify token temizle |

## Veritabanı yedekleme

```bash
npm run backup                 # ./backups altına .sql.gz
npm run backup:keep7           # en fazla 7 dosya tut
node scripts/backup-db.js --out /var/backups/elite --keep 14
```

Gereksinim: sunucuda `pg_dump` ve `gzip` (PostgreSQL client tools).

| Env | Varsayılan | Anlam |
|-----|------------|--------|
| `BACKUP_DIR` | `./backups` | çıktı klasörü |
| `BACKUP_KEEP` | 14 | saklanacak dosya (0 = silme yok) |
| `BACKUP_PREFIX` | `elite-oyun` | dosya öneki |

Cron örneği (her gece 03:15):

```cron
15 3 * * * cd /app && DATABASE_URL=... npm run backup >> /var/log/elite-backup.log 2>&1
```

Render Blueprint (`render.yaml`) artık iki cron tanımlar:
- `elite-manager-backup` — günlük `npm run backup` (03:15 UTC)
- `elite-manager-retention` — haftalık `npm run retention` (Pazar 04:00 UTC)

Blueprint ile deploy edince cron’lar otomatik oluşur. Free planda disk **ephemeral**;
yedek dosyaları kalıcı değildir — gerçek felaket kurtarma için dış yedek (S3/R2) ekleyin.

Manuel: Render Dashboard → New → Cron Job (gerekirse).

Admin UI: Anti-Cheat panelinde **Kilit aç** / **Kilitli listesi** (`POST /api/admin/unlock-login`, `GET /api/admin/locked`).

Giriş kilidi test: `npm run test:lockout` (admin unlock için `SMOKE_ADMIN_USER` / `SMOKE_ADMIN_PASS`).
Başarılı şifre sıfırlama da `failed_login_count` / `locked_until` temizler.
Runtime bakım (restart yok): admin panel **Bakım modu** veya `POST /api/admin/maintenance` `{ "enabled": true, "message": "..." }`. Env `MAINTENANCE_MODE=1` zorlar.

Güvenlik özeti: `GET /api/admin/security-overview`. Hesap kilidinde `SECURITY_WEBHOOK_URL` (yoksa `ERROR_WEBHOOK_URL`) bildirimi.

Post-deploy kontrol: `API_URL=https://... npm run post-deploy`

- Liveness: `/healthz` · Readiness: `/readyz` (bakım/DB down → 503)
- Docker: non-root `elite` user
- `npm run security:audit`

Socket: oturum iptali/ban sonrası `disconnectUserSockets` + `session:ended`. Sürüm: `GET /api/version`.
