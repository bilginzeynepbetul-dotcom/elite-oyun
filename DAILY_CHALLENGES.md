# Günlük görevler (P1 #13)

## API

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/challenges` | Bugünkü 3 görev + ilerleme |
| POST | `/api/challenges/claim` | `{ challengeId }` veya `bonus` |

## Ödüller

- Görev başına: **15.000 €**
- 3/3 bonus: **40.000 €**

## Görev havuzu (günden güne 3 seçilir)

Maça çık, galibiyet, antrenman, transfer teklifi, altyapı keşif, 2 gol

## Migration

```bash
npm run migrate   # 026_daily_challenges.sql
```
