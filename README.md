# MecroTubeVibe

Astro app that stores transit data in SQLite and runs as a Node server behind Nginx.

## Local Development

```sh
npm install
npm run dev
```

## Production Build

```sh
npm run build
npm run start
```

The SQLite database is stored at `data/transit.db`.

## Nginx

Use Nginx as a reverse proxy in front of the Node process started by `npm run start`.
The included `nginx.conf` assumes the app listens on `127.0.0.1:4321`.
