# Transfer bot teklifleri (P1 #8)

## Ne yapar?

Aktif ihalelerde rakip **bot kulüpler** teklif verir:

- İnsan satıcı ilanlarında daha agresif (`~%35` şans/tick)
- AI satıcı ilanlarında daha sakin (`~%18`)
- Bot zaten liderse seyrek
- Son 30 / 5 dakikada hızlanır
- Tavan: oyuncu değerinin **%128**’i
- Anti-snipe: son 2 dk teklifte +2 dk uzatma (bot dahil)

## Kazanan bot

- İnsan satıcıya ödeme yapılır
- Oyuncu bot kadrosuna **eklenmez** (piyasadan çıkar)
- İnsan alıcı akışı değişmez (bütçe + kadro)

## Tetikleyiciler

- `settleExpired()` (30 sn timer)
- `listMarket()` (kullanıcı piyasayı açınca)

## API

Değişiklik yok — mevcut `/api/transfer/*` üzerinden görünür (`highestBidderName` bot kulüp adı).
