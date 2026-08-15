# Sezon otomasyonu (P0 #3)

## Bileşenler

### `seasonAutomation.js` (scheduler)
Her ~4 tick (~60 sn @ 15s interval):

1. **Ayın oyuncusu** — önceki ay finalize + kulübe 75.000 €
2. **Stuck live** — 3+ saat `live` kalan maç → skorla bitir veya 0-0
3. **Overdue scheduled** — kickoff + 48s hâlâ scheduled → 3-0 forfeit (veya bye iptal)
4. **Pending finalize** — tüm maçlar bitmiş aktif sezonları kapat

### `seasonLifecycle.finalizeSeason`
- Şampiyon kaydı + `season_awards`
- Nakit: 1./2./3. → 500k / 250k / 125k (alt lig ×0.75 / ×0.5)
- Gol kralı kulübü +40k, asist kralı +25k
- Yükselme / düşme
- Yeni sezon + fikstür üretimi

### Zaten var olanlar
- Maç sonu `tryFinalizeAfterLeagueMatch`
- Tek sayıda takımda bye pad (null eşleşme üretilmez)
- Kupa `advanceReadyEditions`

## Env

| Değişken | Varsayılan | Anlam |
|----------|------------|--------|
| `STUCK_LIVE_HOURS` | 3 | Live timeout |
| `OVERDUE_SCHEDULED_HOURS` | 48 | Forfeit eşiği |
