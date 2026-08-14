# Ekonomi dengesi (P0 #2)

Tek kaynak: `economyBalance.js`

## Hedef bant (orta kulüp / haftalık)

| Kalem | Yaklaşık |
|--------|----------|
| 18 kişilik maaş | 180–280k € |
| Ev maçı bilet | 160–280k € |
| Lig primi (G/B/M) | 85k / 35k / 12k |
| Günlük ödül | 30k € |
| Başlangıç kasa | 5.000.000 € |

## Ne değişti?

1. **Maç primi** — lig / kupa / kıtasal / dostluk / anlık (`applyMatchPrizeMoney`)
2. **Maaş formülü** — biraz düşürüldü (`estimateWageCalibrated`)
3. **Transfer değeri** — ≈ 45–70× haftalık maaş
4. **Bilet** — doluluk skor sonucuna duyarlı; kıtasal ×1.25
5. **Stadyum** — her +1000 koltuk maliyet %8 artar
6. **Altyapı / antrenör** — maliyet ve maaş kalibre
7. **Günlük ödül** — 50k → 30k

## Lifecycle bağlantıları

- `matchLifecycle` — lig bilet + prim
- `cupLifecycle` / `continentalLifecycle` / `friendlyLifecycle` — prim (+ bilet)

## Ayar

Tüm sabitler `economyBalance.js` içinde; denge için orayı düzenle.
