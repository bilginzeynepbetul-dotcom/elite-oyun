# Elite Manager

Çok oyunculu futbol menajer API + SPA istemci.

## Hızlı başlangıç

```bash
cp env.elite.example .env
# JWT_SECRET ve DATABASE_URL doldurun

npm install
npm run migrate
npm start
# http://localhost:3000
```

Docker:

```bash
docker compose up --build
```

## Testler (sunucu ayaktayken)

```bash
npm test                  # smoke
npm run test:integration  # kayıt → youth → transfer
npm run test:reconnect    # socket reconnect
npm run test:stress       # anlık maç yükü
npm run test:stress-load  # genel API yükü
npm run check-db          # DB tabloları
```

## Ana sistemler

| Modül | Açıklama |
|-------|----------|
| `server.js` | Express + Socket.IO + route mount |
| `matchEngine` + lifecycle | Otoriter maç motoru, bilet, prim, form |
| `seasonLifecycle` / `seasonAutomation` | Sezon kapanışı, forfeit, ayın oyuncusu |
| `youthSystem` | Altyapı keşif / yükseltme |
| `transferSystem` | Piyasa + bot teklifleri + settle |
| `trainingSystem` / `trainingAuto` | Antrenman + haftalık otomatik |
| `stadiumSystem` | Kapasite / bilet / isim |
| `contractSystem` | Maaş bordrosu (timer) |
| `achievementsSystem` / `dailyChallengeSystem` | Başarı + günlük görev |
| `secondTeamSystem` | Elite B takımı |
| `national` / `cup` / `continental` | Milli / kupa / kıtasal |

## Ortam değişkenleri

Zorunlu: `JWT_SECRET`, `DATABASE_URL`  
Önemli: `ADMIN_USERNAME`, `PORT`, `CORS_ORIGIN`  
Ayrıntılar: `env.elite.example`

## Canlıya alma kontrol listesi

1. **JWT_SECRET** — `openssl rand -hex 32` ile üretip `.env`'e yazın (≥16 karakter; production için 32+ byte hex). Hardcoded fallback yok.
2. **DATABASE_URL** — gerçek Postgres. `PGSSL=require` (varsayılan barındırılan), `verify` (CA doğrulama) veya `disable` (local).
3. **ADMIN_USERNAME** — yönetici kullanıcı adı (case-insensitive). O kullanıcı adıyla kayıt = admin.
4. **CORS_ORIGIN** — production'da **zorunlu** (`NODE_ENV=production` + boş CORS → boot fail). Virgülle çoklu domain.
5. **ELITE_ALLOW_MOCK=0** — production'da `1` yasak (boot fail).
6. **npm run migrate** — `001`…`028` (token_version + national schema ensure dahil). `npm start` otomatik migrate eder.
7. **Health check** — `/healthz` (DB) ve `/api/health` (errorTracker stats).
8. **Loglar** — `ERROR_LOG_FILE`, `ERROR_WEBHOOK_URL`, `ERROR_ADMIN_TOKEN`.
9. **Donation alanları** — gerçek IBAN/Papara.
10. Deploy sonrası `npm run test:all`.
11. **Güvenlik (özet)** — graceful shutdown (SIGTERM); JWT `tv` ile iptal (şifre sıfırlama / ban / `POST /api/auth/logout-all`); şifre min 8; reset brute-force kilidi; trust proxy; güvenlik başlıkları; HS256 sabiti.
