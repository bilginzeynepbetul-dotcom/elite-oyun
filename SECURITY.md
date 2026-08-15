# Güvenlik özeti — Elite Manager

Bu doküman mevcut güvenlik ve operasyon kontrollerini özetler.

## Kimlik doğrulama

| Kontrol | Detay |
|---------|--------|
| JWT access + refresh | HS256, `JWT_SECRET` zorunlu |
| `token_version` | Şifre değişimi / logout-all / ban / admin revoke ile tüm oturumlar düşer |
| Hesap kilidi | `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` |
| IP kademeli gecikme | `LOGIN_IP_DELAY_*` |
| Kalan deneme | `remainingAttempts` (BAD_CREDENTIALS) |
| E-posta doğrulama | `EMAIL_REQUIRE_VERIFIED=1` |

## Admin

| Endpoint / UI | Açıklama |
|---------------|----------|
| `/api/admin/unlock-login` | Giriş kilidini aç |
| `/api/admin/locked` | Kilitli hesaplar |
| `/api/admin/revoke-sessions` | Oturum + socket düşür |
| `/api/admin/online-users` | Çevrimiçi (socket) kullanıcılar |
| `/api/admin/maintenance` | Runtime bakım |
| `/api/admin/security-overview` | Kilit/ban/bakım özeti |
| Ban / Unban / Audit | Anti-Cheat paneli |

## Socket.IO

- Handshake: JWT + `token_version` + ban + `deleted_at`
- İptal/ban/silme → `disconnectUserSockets` + `session:ended`
- Periyodik revalidate: `SOCKET_REVALIDATE_MS` (varsayılan 5 dk)

## Operasyon

| Araç | Komut / endpoint |
|------|------------------|
| Liveness | `GET /healthz` |
| Readiness | `GET /readyz` (bakım/DB → 503) |
| Sürüm | `GET /api/version` |
| Yedek | `npm run backup` |
| Post-deploy | `npm run post-deploy` |
| npm audit | `npm run security:audit` |
| Kilit testi | `npm run test:lockout` |

## Webhook

- `ERROR_WEBHOOK_URL` — hatalar
- `SECURITY_WEBHOOK_URL` — hesap kilidi (yoksa ERROR kullanılır)

## Production checklist

Ayrıntılar: [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md), [DEPLOY.md](./DEPLOY.md).

Docker imajı **non-root** (`elite` kullanıcısı) çalışır.

- Socket handshake IP limiti: `SOCKET_IP_CONNECT_MAX` (varsayılan 60/dk)
- `ACCOUNT_LOCKED` olayları `anti_cheat_log` tablosuna da yazılır.

- Bakım aç/kapa → Socket `maintenance:status` broadcast (anlık banner).
