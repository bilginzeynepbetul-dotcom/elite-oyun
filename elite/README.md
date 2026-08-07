# Elite Manager Online

Cok oyunculu, gercek zamanli futbol menajerlik oyunu.

## Docker ile calistir (onerilen)

```bash
cd artifacts
docker compose up --build
```

Acilan adresler:
- Oyun:  http://localhost:3000
- API:   http://localhost:3000/health
- DB:    localhost:5432 (em / em / elite_manager)

Ilk acilista migrate otomatik calisir.

## Nasil oynanir

1. Tarayicida http://localhost:3000 ac
2. Kayit ol (kullanici adi + sifre + takim adi)
3. Ikinci hesap icin gizli pencere / baska tarayici
4. Lig botlarla dolar, fikstur olusur
5. "Siradaki Mac" → Izle (kickoff saati gelince canli baslar)

## Smoke test

```bash
# API ayaktayken
npm install
API_URL=http://localhost:3000 npm run smoke
```

## Lokal (Docker sadece DB)

```bash
docker compose up -d db
export DATABASE_URL=postgres://em:em@localhost:5432/elite_manager
export JWT_SECRET=dev-secret
npm install
npm run migrate
npm start
```

## Durdurma

```bash
docker compose down
# veri silinsin istiyorsan:
docker compose down -v
```
