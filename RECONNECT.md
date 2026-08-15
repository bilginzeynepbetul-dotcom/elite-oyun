# Maç içi reconnect — güçlendirme notları

## Ne çözüldü?

Canlı maç izlerken socket kopunca istemci odaya otomatik dönmüyor, state
bir sonraki tick’e (veya 3 sn poll’a) kalıyordu → boş saha / donuk skor.

## İstemci (`public/multiplayer-client.js`)

- Socket.IO: agresif reconnection (`800ms` → max `5s`, sınırsız deneme)
- `connect` → `rewatchLiveMatch("reconnect")`:
  - `fixtureId` + `matchId` ile `fixture:watch`
  - `sessionStorage` üzerinden `_emMySide` restore
  - Banner: **«🔄 Maç senkronize ediliyor…»** (state gelince kapanır)
- `match:your-side` → `persistMatchSide` (sessionStorage)
- `match:state` → sync banner kapat
- Maç bitince side + matchId temizlenir
- Auth hatasında kullanıcıya «oturum süresi dolmuş» mesajı

## Sunucu (`server.js`)

- `fixture:watch` hem `fixtureId` hem `matchId` yolunda:
  - anlık `match:state`
  - son 15 `match:log`
  - `match:your-side`

## Instant (`public/index.html`)

- `__emWatchInstantMatch` → `_emWatchingMatchId` set eder

## Smoke

```bash
npm i
# sunucu ayaktayken:
npm run test:reconnect
```

`scripts/smoke-reconnect.js`:
1. register + vs-bot
2. watch → state
3. disconnect
4. reconnect → watch (fixtureId+matchId) → state
5. side tutarlılığı
6. matchId-only watch

## Bilinen sınırlar

- JWT tamamen expire olduysa socket auth fail → sayfa yenileme gerekir
  (token refresh akışı yok).
- Çoklu sekme aynı maçı izlerken davranış smoke edilmedi.
