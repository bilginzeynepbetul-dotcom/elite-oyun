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

1. **JWT_SECRET** — `openssl rand -hex 32` ile üretip `.env`'e (veya Render'da "Generate Value" ile) yazın. Örnek/varsayılan değeri asla production'da kullanmayın.
2. **DATABASE_URL** — gerçek Postgres bağlantısı (Render/Supabase/Docker). `PGSSL` yalnızca yerel değilse otomatik `require` moduna geçer, elle ayar gerekmez.
3. **ADMIN_USERNAME** — yönetici olacak hesabın kullanıcı adını buraya yazın; o kullanıcı adıyla normal kayıt olduğunuzda admin yetkisi kazanır (ayrı şifre yok).
4. **CORS_ORIGIN** — production'da mutlaka gerçek domain(ler)inizi yazın (virgülle ayırarak). Boş bırakılırsa tüm originlere izin verilir — sadece geliştirmede güvenlidir.
5. **ELITE_ALLOW_MOCK=0** — production'da kapalı olmalı; sadece test/geliştirmede `1` yapılır (mock ödeme).
6. **npm run migrate** — deploy sırasında `npm start` zaten migration'ları otomatik çalıştırır (`001`'den `026`'ya kadar hepsi sırayla ve idempotent).
7. **Health check** — `/healthz` endpoint'i DB bağlantısını da test eder; Render/Docker/uptime monitörü buraya bağlanabilir.
8. **Loglar** — `ERROR_LOG_FILE` verirseniz klasör otomatik oluşturulur; vermezseniz sadece konsola/webhook'a (varsa `ERROR_WEBHOOK_URL`) yazar.
9. **Donation alanları** (`DONATION_IBAN` vb.) — gerçek IBAN/Papara bilgilerinizle doldurun, boş bırakılırsa Elite sayfasında bağış bölümü eksik görünür.
10. Deploy sonrası `npm run test:all` ile smoke + entegrasyon + reconnect testlerini canlı ortama karşı (ya da staging'e karşı) çalıştırıp doğrulayın.
