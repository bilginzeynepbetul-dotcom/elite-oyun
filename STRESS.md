# Yük / stres testleri (P0 #5)

Sunucu ayaktayken çalıştırın.

## Scriptler

### 1) Anlık maç kuyruğu — `stress-instant.js`
```bash
API_URL=http://localhost:3000 STRESS_USERS=10 npm run test:stress
```
- N kullanıcı kaydı  
- presence + queue/join + vs-bot  

### 2) Genel yük — `stress-load.js`
```bash
API_URL=http://localhost:3000 \
  STRESS_USERS=12 \
  STRESS_MATCHES=4 \
  STRESS_ROUNDS=3 \
  STRESS_CONCURRENCY=8 \
  npm run test:stress-load
```

| Env | Varsayılan | Açıklama |
|-----|------------|----------|
| `STRESS_USERS` | 12 | Eşzamanlı kullanıcı (max 40) |
| `STRESS_MATCHES` | 4 | Paralel vs-bot |
| `STRESS_ROUNDS` | 3 | API turu / kullanıcı |
| `STRESS_CONCURRENCY` | 8 | Paralel istek |
| `STRESS_SOCKETS` | 0 | `1` → socket izleme |

Rapor: ok/fail, RPS, p50/p95/p99, path bazlı ortalama, örnek hatalar.

**Başarı eşiği:** ok oranı ≥ %85, p95 ≤ 8s.

Socket ile:
```bash
STRESS_SOCKETS=1 npm run test:stress-load
# socket.io-client devDependency gerekir
```

### Hepsi
```bash
npm run test:stress-all
```

## Notlar

- Ücretsiz Render soğuk başlangıç p95’i şişirir; yerelde ölçün.  
- DB connection pool (`DB_POOL_MAX`) düşükse kayıt patlaması 500 üretebilir.  
- Canlı maç sayısı `instantMatchSystem.MAX_INSTANT_LIVE` ile sınırlıdır.
