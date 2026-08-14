# Form / kondisyon kalıcılığı (P1 #11)

## Ne yapar?

Maç bitince oyuncu **form** (-5..+5) ve **condition** (28..100) `players` tablosuna yazılır.

| Durum | Form etkisi |
|-------|-------------|
| Galibiyet (oynadı) | +0.8 |
| Beraberlik | +0.15 |
| Mağlubiyet | -0.7 |
| Gol / asist | +0.45 / +0.3 |
| Oynamadı | hafif nötr / -0.2 |
| Condition < 45 | ek -0.25 |

Kondisyon: maç sonu değer kalır; yedekler +3; kulüpte kalanlar +2 (88 altı).

## Hook

- `matchLifecycle` (lig)
- `cupLifecycle` (kupa)

## Dosya

`playerFormSystem.js` — `applyPostMatchForm`, `applyTrainingBoost`
