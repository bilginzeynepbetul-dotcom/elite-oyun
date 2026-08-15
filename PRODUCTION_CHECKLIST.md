# Production checklist — Elite Manager

Canlıya almadan ve her major deploy sonrası gözden geçirin.

## 1. HTTPS / TLS

- [ ] Domain üzerinde geçerli TLS sertifikası (Render/Cloudflare otomatik yönetir)
- [ ] `PUBLIC_URL` ve `CORS_ORIGIN` **https://** ile başlıyor
- [ ] HTTP → HTTPS yönlendirmesi açık (platform tarafı)
- [ ] HSTS sunucuda production’da gönderiliyor (`Strict-Transport-Security`)
- [ ] Mixed content yok (tüm API çağrıları aynı origin veya HTTPS)

## 2. Secret / anahtar rotasyonu

| Secret | Oluşturma | Not |
|--------|-----------|-----|
| `JWT_SECRET` | `openssl rand -hex 32` | Değişince **tüm oturumlar düşer** |
| `ADMIN_USERNAME` | — | Admin panel yetkisi |
| `MAINTENANCE_BYPASS_TOKEN` | `openssl rand -hex 16` | Bakım sırasında admin erişimi |
| `ERROR_ADMIN_TOKEN` | rastgele | Hata paneli (varsa) |
| DB şifresi | platform | `DATABASE_URL` içinde |
| `RESEND_API_KEY` / SMTP | sağlayıcı | E-posta |

Rotasyon adımları (`JWT_SECRET`):
1. Yeni secret üret, staging’de dene
2. Production env’i güncelle → restart
3. Kullanıcılara “tekrar giriş” mesajı (beklenen davranış)
4. Eski secret’ı saklamayın

- [ ] `.env` commit edilmedi (`.gitignore`)
- [ ] Dashboard / secret store dışında secret paylaşılmıyor
- [ ] Eski çalışanlardan secret erişimi kaldırıldı

## 3. Zorunlu production env

```
NODE_ENV=production
DATABASE_URL=...
JWT_SECRET=...
ADMIN_USERNAME=...
CORS_ORIGIN=https://your-domain.com
PUBLIC_URL=https://your-domain.com
ELITE_ALLOW_MOCK=0
```

Önerilen:
```
EMAIL_REQUIRE_VERIFIED=1
LOGIN_MAX_FAILURES=8
LOGIN_LOCK_MINUTES=15
LOGIN_IP_DELAY_BASE_MS=250
LOGIN_IP_DELAY_MAX_MS=8000
API_RATE_LIMIT_MAX=120
MAINTENANCE_MODE=0
```

- [ ] Boot: boş `CORS_ORIGIN` / `ADMIN_USERNAME` / `ELITE_ALLOW_MOCK=1` → process **çıkmamalı** (kod engelliyor)

## 4. Monitoring / sağlık

- [ ] Runtime bakım: Admin panelden aç/kapa testi (`/api/admin/maintenance`)

- [ ] Uptime monitor: `GET /healthz` → `ok: true`, `db: "up"` (1–5 dk aralık)
- [ ] Uptime monitor: `GET /api/health` (bakım bayrağı: `maintenance`)
- [ ] 5xx / yavaş istek: `ERROR_WEBHOOK_URL` veya `ERROR_LOG_FILE`
- [ ] Disk / bellek alarmı (host veya Render metrics)
- [ ] DB bağlantı sayısı (`DB_POOL_MAX`) izleniyor

Bakım:
```bash
# API’yi kapat (statik + health açık)
MAINTENANCE_MODE=1
MAINTENANCE_MESSAGE=Planlı bakım 02:00–02:30
MAINTENANCE_BYPASS_TOKEN=...
```

## 5. Yedekleme & KVKK

- [ ] Günlük `npm run backup` (cron / Render Cron)
- [ ] Yedekler şifreli veya erişim kısıtlı depoda
- [ ] Geri yükleme tatbikatı yapıldı (en az bir kez)
- [ ] Haftalık `npm run retention` (log saklama süreleri)
- [ ] Gizlilik / KVKK / çerez sayfaları güncel

## 6. Güvenlik kontrolleri

- [ ] Giriş kilidi: `npm run test:lockout`
- [ ] Admin: ban / unban / kilit aç / audit log
- [ ] Rate limit tek instance varsayımı (çok instance → Redis gerekir)
- [ ] `trust proxy` yalnızca gerçek proxy arkasında (Render: OK)
- [ ] Admin kullanıcı güçlü şifre (≥ 12, benzersiz)

## 7. Deploy doğrulama (smoke)

```bash
curl -sS https://YOUR/healthz
curl -sS https://YOUR/api/health
npm run test          # smoke
npm run test:lockout  # kilit
```

Manuel:
1. Kayıt + e-posta doğrulama (açıksa)
2. Giriş / çıkış / refresh
3. Kadro, lig, transfer
4. Admin paneli görünür mü
5. Destek Ol IBAN doğru mu

## 8. Olay müdahalesi (kısa)

| Belirti | Aksiyon |
|---------|---------|
| Brute-force | Kilitli liste + unlock-login; gerekirse IP/WAF |
| Data şüphesi | Backup’tan restore tatbikatı; audit log |
| JWT sızıntısı | `JWT_SECRET` rotate + restart |
| Acil kapatma | `MAINTENANCE_MODE=1` |

---

İlgili: [DEPLOY.md](./DEPLOY.md), [ERROR_TRACKING.md](./ERROR_TRACKING.md), [AUTH_REFRESH.md](./AUTH_REFRESH.md)

Güvenlik özeti: `GET /api/admin/security-overview`. Hesap kilidinde `SECURITY_WEBHOOK_URL` (yoksa `ERROR_WEBHOOK_URL`) bildirimi.

Post-deploy kontrol: `API_URL=https://... npm run post-deploy`

- Liveness: `/healthz` · Readiness: `/readyz` (bakım/DB down → 503)
- Docker: non-root `elite` user
- `npm run security:audit`

Socket: oturum iptali/ban sonrası `disconnectUserSockets` + `session:ended`. Sürüm: `GET /api/version`.
