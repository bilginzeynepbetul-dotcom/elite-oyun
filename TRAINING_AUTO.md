# Haftalık otomatik antrenman (P1 #12)

## Ne yapar?

Scheduler (`seasonAutomation`, ~60 sn) üzerinden:

1. **Haftalık auto train** — insan kulüpler, haftada 1 kez  
   - Odak skill: en yüksek antrenör veya haftalık rotasyon  
   - `trainSquad` ile skill artışı  
   - Ardından condition +4 toparlanma  

2. **Dinlenme** — condition < 92 olanlara +3  

3. **Manuel antrenman** — `trainSquad` artık hafif yorgunluk (condition -2..-4)

## Anahtar

`game_settings.training_auto_week = "2026-W12"` — aynı hafta tekrar yok.

## Dosya

`trainingAuto.js` — `runWeeklyTrainingAuto`, `runRestRecovery`
