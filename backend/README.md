# MecroTube Backend

Small Go backend serving the MecroTube API backed by SQLite.
Single static binary, no cgo (uses `modernc.org/sqlite`).

## Routes

| Method | Path              | Description                                                  |
| ------ | ----------------- | ------------------------------------------------------------ |
| GET    | `/api/transit`    | Public transit data (stops + lines)                          |
| PUT    | `/api/transit`    | Replace transit data — requires `Authorization: Bearer <pw>` |
| POST   | `/api/admin-auth` | Validate the admin password (`{"ok": true}` on success)      |

There are no sessions or cookies. The admin password itself is the credential:
the admin page validates it once via `POST /api/admin-auth`, keeps it in the
browser's sessionStorage, and sends it as a bearer token on write requests.

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
