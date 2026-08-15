# Maç günü bildirimleri (P1 #9)

## Ne zaman?

| Tür | Tetikleyici | Metin |
|-----|-------------|--------|
| **Pre** | Kickoff ≤ 60 dk (varsayılan) | `Maç yaklaşıyor · Ev vs Dep · tarih` |
| **Start** | Scheduler maçı başlatınca | `Maç başladı · … — canlı izleyebilirsin` |

Sadece **insan menajer** (`clubs.user_id`) olan taraflara gider.

## Tekrar koruması

- Process içi `Set`
- `game_settings` anahtarı: `notify:{fixtureId}:pre|start`

## Env

```env
MATCH_NOTIFY_PRE_MIN=60   # yaklaşan maç penceresi
MATCH_NOTIFY_ON_START=1   # 0 ile kapat
```

## Dosyalar

- `matchNotify.js`
- `matchScheduler.js` — her tick `runMatchNotify`
- `matchLifecycle.js` — start sonrası `notifyMatchStarted`
