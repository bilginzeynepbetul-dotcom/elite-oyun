# Başarılar / trofeler (P1 #10)

## API

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/achievements` | Kullanıcı profili (kilitli/açık) |
| GET | `/api/achievements/defs` | Tüm tanımlar |

## Migration

```bash
# 025_achievements.sql — scripts/migrate.js ile
npm run migrate
```

## Örnek başarılar

- İlk zafer, gol yemeden galibiyet, 3+ fark
- 3 / 5 maçlık seri
- 10 / 50 maç
- Lig şampiyonu, yükselme
- İlk transfer alım/satım
- Altyapıdan oyuncu
- Elite üyelik

## Hook noktaları

- `matchLifecycle` maç sonu
- `seasonLifecycle` şampiyon / yükselme
- `transferSystem` satış sonucu
- `premiumSystem.activatePlan`
- `youthSystem.drawPlayer`
