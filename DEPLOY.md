# Canlıya alma

## Env (Render Dashboard) — zorunlu

| Key | Değer |
|-----|--------|
| `NODE_ENV` | `production` |
| `ADMIN_USERNAME` | İlk kayıt olacağın kullanıcı adı |
| `CORS_ORIGIN` | `https://SENIN-SERVIS.onrender.com` |
| `ELITE_ALLOW_MOCK` | `0` |
| `DATABASE_URL` | Otomatik (DB’den) |
| `JWT_SECRET` | Otomatik / `openssl rand -hex 32` |
| `PUBLIC_URL` | Aynı https URL (önerilir) |
| `DONATION_IBAN` + `DONATION_IBAN_NAME` | Gerçek IBAN |

Boş `CORS_ORIGIN` / `ADMIN_USERNAME` / `DATABASE_URL` veya `ELITE_ALLOW_MOCK=1` → production **başlamaz**.

---

## Deploy sonrası

1. `/healthz` → `ok` + `db: up`
2. Site açılsın
3. `ADMIN_USERNAME` ile kayıt (şifre ≥ 8)
4. Giriş → sonraki maç dolu mu
5. Kadro / forum / Destek Ol IBAN
6. Admin menü çalışıyor mu

---

## Not

- Sonraki maç rakip isimleri her DB’de farklıdır (normal).
- Kod tarafı canlıya hazır; sende kalan sadece Dashboard env + ilk kayıt.
