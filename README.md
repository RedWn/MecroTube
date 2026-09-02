# MecroTubeVibe

Static Astro site for viewing/editing transit lines. All dynamic behavior (data
storage, admin auth) is provided by a small standalone Node API server
(`server/`) backed by SQLite.

## Local Development

```sh
npm install
npm run api   # starts the API server on 127.0.0.1:4322
npm run dev   # Astro dev server on :4321, proxies /api to the API server
```

## Production Build

```sh
npm run build   # outputs static files to dist/
npm run api     # run the API server (SQLite + admin password auth)
```

The SQLite database is stored at `data/transit.db`; the admin password lives in
`data/admin-password.txt` (default `changeme` — change it before deploying).

## Backend URL

The frontend talks to the backend under `/api` on the same origin by default
(the dev server and the included `nginx.conf` both proxy `/api` to the API
server). To point the app at a backend on a different origin, set
`PUBLIC_API_URL` at build time (e.g. in a `.env` file):

```sh
PUBLIC_API_URL=https://api.example.com npm run build
```


## Nginx

The included `nginx.conf` serves `dist/` statically and proxies `/api/` to the
API server on `127.0.0.1:4322`.
