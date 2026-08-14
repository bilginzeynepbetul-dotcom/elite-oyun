# İkinci takım / B takımı (P1 #7)

## Özet

Elite üyelere A takımından bağımsız **B takımı**:
- Sunucu otoriteli kadro (`clubs.second_team` JSONB)
- 11+ yedek oyuncu (A’dan biraz düşük skill bandı)
- Bütçe 1.5M başlangıç (istemci artıramaz)
- Varsayılan 2. lig / aynı ülke

## API

| Method | Path | Açıklama |
|--------|------|----------|
| GET | `/api/premium/second-team` | Durum + kadro |
| POST | `/api/premium/second-team/ensure` | Yoksa oluştur |
| POST | `/api/premium/second-team/rename` | İsim |
| POST | `/api/premium/second-team` | Tam kayıt (sanitize) |

## Dosyalar

- `secondTeamSystem.js` — create / normalize / save / anti-cheat bütçe
- `premiumRoutes.js` — route’lar
- Client: `__emEnsureSecondTeamServer`, `unlockSecondTeamSlot` sunucu öncelikli

## Not

B takımı lig fikstürü hâlâ istemci `registerSecondTeamInLeague` ile; tam çok oyunculu 2. lig fikstürü ayrı iş kalemi olabilir.
