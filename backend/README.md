# MecroTube Backend

Small Go backend serving the MecroTube API backed by SQLite.
Single static binary, no cgo (uses `modernc.org/sqlite`).

## Routes

| Method | Path              | Description                                          |
| ------ | ----------------- | ---------------------------------------------------- |
| GET    | `/api/transit`    | Public transit data (stops + lines)                  |
| PUT    | `/api/transit`    | Replace transit data (requires admin session cookie) |
| POST   | `/api/admin-auth` | Log in with the admin password; sets session cookie  |
| GET    | `/api/admin-auth` | Returns `{ "authenticated": bool }`                  |
| DELETE | `/api/admin-auth` | Log out; clears session cookie                       |

## Configuration

| Env var   | Default | Description                                  |
| --------- | ------- | -------------------------------------------- |
| `PORT`    | `4322`  | Listen port (binds to `127.0.0.1`)           |
| `DATA_DIR`| `data`  | Directory for `transit.db` and `admin-password.txt` |

On first run a default password file `data/admin-password.txt` is created
containing `changeme` — change it before deploying. The password is re-read
from disk on every login attempt, so changes take effect immediately.

## Build & run

```sh
go build -o backend-server .
./backend-server
```
