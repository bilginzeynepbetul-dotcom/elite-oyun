# Sözleşme / Maaş — entegrasyon notları

Dosyalar (`artifacts/` → proje köküne kopyala):

| Dosya | Hedef |
|-------|--------|
| `010_player_contracts.sql` | `migrations/` veya migrate'in okuduğu klasör |
| `contractSystem.js` | proje kökü (`server.js` yanı) |
| `contractRoutes.js` | proje kökü |

## 1. migrate.js

`files` dizisine ekle:

```js
"010_player_contracts.sql",
```

Sonra: `npm run migrate`

## 2. clubsRepo.js — rowToPlayer

`rowToPlayer` dönüşüne ekle:

```js
wage: Number(r.wage) || 0,
contractEndsAt: r.contract_ends_at || null,
lastWagePaidAt: r.last_wage_paid_at || null,
```

`getClub` SELECT listesine (opsiyonel):

```sql
last_payroll_at
```

`saveTeam` UPDATE/INSERT'e `wage` ve `contract_ends_at` eklemek istersen
(client'tan gelen değeri korumak için); yoksa bordro/yenileme API'si yeterli.

## 3. server.js

```js
const { createContractRouter } = require("./contractRoutes");
const contractSystem = require("./contractSystem");

// route'lar (authMiddleware sonrası):
app.use(
  "/api/contracts",
  authMiddleware,
  createContractRouter({ getClubId: (req) => req.user.clubId }),
);

// boot sonunda:
contractSystem.startPayrollTimer();
```

`enrichClubId` kullanıyorsan:

```js
createContractRouter({
  getClubId: async (req) => {
    const { enrichClubId } = require("./authRoutes");
    return enrichClubId(req);
  },
});
```

(Router senkron `getClubId` bekliyorsa `teamRoutes` gibi içeride `enrichClubId` çağır.)

## 4. wireSystems.js (opsiyonel)

Youth/transfer sonrası sözleşme:

```js
const contractSystem = require("./contractSystem");
// youth draw / transfer settle sonrası:
// await contractSystem.ensureContract(player.id, clubId, player);
```

## 5. API özeti

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/contracts` | Haftalık bordro + oyuncu maaşları |
| POST | `/api/contracts/renew` | `{ playerId, years, wage }` |
| POST | `/api/contracts/release` | `{ playerId }` — tek oyuncuyu serbest bırak (ilk 11 ve min. kadro korumalı) |
| POST | `/api/contracts/pay` | Elle bordro (test) |
| POST | `/api/contracts/release-expired` | Moral düşük + 14 gün geçmiş serbest |

## 6. Test env

```env
WAGE_INTERVAL_MS=60000
```

1 dakikada bir bordro denemesi (normalde 7 gün).

## 7. UI (multiplayer-client / index)

Kadro satırında `wage` + `daysLeft` göster; süre bitimine 90 gün kala
“Yenile” → `POST /api/contracts/renew`.

Ekonomi paneline `weeklyTotal` ekle.

**Durum: tamamlandı.** `public/index.html` içindeki Kontrat sekmesi
(`renderSquadContractsPage`) artık gerçek `/api/contracts` verisini
çekiyor; "Yenile" ve "Serbest Bırak" butonları sırasıyla
`/api/contracts/renew` ve `/api/contracts/release` çağırıyor. Önceden
bu sekme tamamen client-only rastgele veriyle çalışıyordu (gerçek
maaş/bordro sunucuda sessizce kesiliyordu ama kullanıcı hiç
göremiyordu, "Yenile"/"Serbest Bırak" ise hiçbir şeyi kalıcı
değiştirmiyordu).
