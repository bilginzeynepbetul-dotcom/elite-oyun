# JWT refresh / uzun oturum (P0 #4)

## Model

| Token | Ömür (varsayılan) | Kullanım |
|-------|-------------------|----------|
| **Access** | `2h` (`JWT_EXPIRES` / `JWT_ACCESS_EXPIRES`) | API + Socket |
| **Refresh** | `30d` (`JWT_REFRESH_EXPIRES`) | Sadece `POST /api/auth/refresh` |

Access payload: `{ sub, username, clubId, typ: "access" }`  
Refresh payload: `{ sub, username, clubId, typ: "refresh" }`

Refresh token ile normal API/socket çağrısı **reddedilir**.

## API

- `POST /api/auth/login` → `token`, `accessToken`, `refreshToken`, `expiresIn`
- `POST /api/auth/register` → aynı
- `POST /api/auth/refresh` `{ refreshToken }` → yeni çift

## İstemci

- `localStorage`: `em_jwt_token` + `em_jwt_refresh`
- `apiFetch`: 401 → bir kez refresh → retry
- Proaktif yenileme: access bitmeden ~90 sn önce
- Socket `auth.token` refresh sonrası güncellenir
- Logout her iki token’ı siler

## Env

```env
JWT_SECRET=...
JWT_EXPIRES=2h
JWT_REFRESH_EXPIRES=30d
```
