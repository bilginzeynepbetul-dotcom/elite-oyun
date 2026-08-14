# Kalıcı hata izleme (P0 #6)

## Bileşenler

| Dosya | Rol |
|-------|-----|
| `logger.js` | Yapılandırılmış JSON/text log (`LOG_LEVEL`, `LOG_FORMAT`) |
| `errorTracker.js` | Ring buffer + dosya + webhook + Express/process hook |

## Ne yakalanır?

- Express 500 hataları (`expressErrorHandler`) → `errorId` + `requestId` client’a döner
- HTTP 5xx finish olayları
- `uncaughtException` / `unhandledRejection`
- İsteğe bağlı: kod içinden `captureError(err, ctx)`

## Env

```env
LOG_LEVEL=info          # debug|info|warn|error
LOG_FORMAT=json         # json|text
ERROR_WEBHOOK_URL=      # Discord webhook veya generic JSON POST
ERROR_LOG_FILE=./logs/errors.ndjson
ERROR_BUFFER_SIZE=100
ERROR_ADMIN_TOKEN=      # alternatif admin erişimi
```

## API

- `GET /health` → `errors: { buffered, totalCaptured, webhook, logFile }`
- `GET /api/admin/errors?limit=30` — admin kullanıcı veya `X-Error-Token: ERROR_ADMIN_TOKEN`

## Kodda kullanım

```js
const { captureError } = require("./errorTracker");
const logger = require("./logger");

logger.info("match_started", { fixtureId });
captureError(err, { path: "/api/x", userId, requestId, tags: ["transfer"] });
```
