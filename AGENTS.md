# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Note: `CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`.

## Commands

```sh
npm run dev        # dev server at localhost:4321
npm run build      # production build to ./dist/
npm run preview    # preview the build
npx astro check    # TypeScript / Astro type checking (there is no test suite or linter)
```

When starting the dev server, prefer background mode: `astro dev --background`, managed with
`astro dev stop`, `astro dev status`, and `astro dev logs`.

Requires Node >= 22.12.0. `astro check` needs `@astrojs/check`, `typescript`, and `@types/node`
in devDependencies; without them it stops at an interactive install prompt and exits 0 without
checking anything, which reads as a pass.

## Architecture

A bilingual (English/Arabic) transit-map editor for Damascus. Astro in SSR mode (`output: 'server'`)
with a Vercel adapter; Leaflet renders the map. There is no UI framework — all interactivity lives in
one vanilla-TS class.

**Data model** ([src/lib/types.ts](src/lib/types.ts)) — the whole app is `TransitData = { stops, lines }`.
A `TransitLine` references stops by id in `stopIds`, an ordered list that may repeat an id (a branch
revisiting a stop). Every `Stop` and `TransitLine` carries both `nameEn` and `nameAr`.

**Client** ([src/scripts/transit-app.ts](src/scripts/transit-app.ts)) — `DamascusTransitApp` owns the
entire UI: map layers, sidebar, and editor panel. It holds `this.data` in memory, mutates it directly,
then calls `this.save()` (fire-and-forget PUT) and re-renders. Rendering is full teardown/rebuild —
`renderMap()` removes every layer and redraws. State that drives rendering: `selectedLineId` and
`addingStops`.

**Route geometry** ([src/lib/routing.ts](src/lib/routing.ts)) — `snapToRoads()` calls OSRM to bend
polylines onto real streets; one request carries a whole line's waypoints. Every failure path
(offline, rate-limited, >100 waypoints, non-`Ok` response) returns straight segments instead of
throwing, so the map always renders. Results are cached per exact stop geometry. `smoothPath()` is
the offline alternative: a Catmull-Rom spline that interpolates through every stop. The mode is
cycled by the map toolbar and persisted in the `geom` query param. `PUBLIC_OSRM_URL` overrides the
public demo server, which is rate-limited and unsuitable for production.

**Persistence** — client → `PUT /api/transit` ([src/pages/api/transit.ts](src/pages/api/transit.ts))
→ [src/lib/server-data.ts](src/lib/server-data.ts), which picks a backend at runtime:
Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set, otherwise a local `data/transit-data.json`
(gitignored, written atomically via temp file + rename). There is no seed data; an empty store
returns `{ stops: [], lines: [] }`. `parseTransitData()` in [src/lib/storage.ts](src/lib/storage.ts)
is the single validation gate — used by the API route, the blob/file readers, and the import flow.

**Editor rendering** — `renderSidebar()` rebuilds freely, but the editor does not: `buildEditor()`
runs once per selected line and `refreshEditor()` thereafter syncs values in place, skipping any
input that currently holds focus. Rebuilding on each keystroke (the previous behavior) destroyed
the focused field mid-typing. `editorRefs` holds the reused nodes; clear it when the selection changes.

**i18n** — Astro's `i18n` config with `prefixDefaultLocale: false`: English at `/`, Arabic at `/ar/`.
Both routes are near-identical thin shells that instantiate `DamascusTransitApp` with a `locale`.
All UI strings live in the `dictionaries` object in [src/i18n/ui.ts](src/i18n/ui.ts) — adding a string
means adding it to both `en` and `ar`, and this is enforced at compile time: `t()` keys off
`keyof typeof dictionaries['en']` and indexes `dictionaries[locale]`, so a key present in one
dictionary but not the other fails `astro check`. This only holds because `Locale` is imported
correctly — an unresolved import there degrades it to `any` and silently disables the check.
[src/layouts/Layout.astro](src/layouts/Layout.astro) sets `dir="rtl"` for Arabic and renders the
static shell (`#map`, `#line-list`, `#line-editor`, buttons) that the app script queries by id.

## Things to watch out for

- **`base` differs per target.** `astro.config.mjs` sets `base: '/MecroTube'` locally but `'/'` on
  Vercel. Never hardcode a URL path — derive it from `import.meta.env.BASE_URL`, as the API URL in
  `transit-app.ts` and the links in `Layout.astro` do.
- **Orphan stops are garbage-collected.** `save()` calls `cleanupOrphanStops()`, which drops any stop
  no line references. A stop added without being pushed onto a line's `stopIds` disappears on the next save.
- **Saves are serialized** through a `saveChain` promise so rapid edits reach the server in order.
- **Manual marker dragging.** Leaflet `CircleMarker` isn't draggable, so drag is hand-rolled via
  map-level `mousemove`/`mouseup` with a 4px threshold, to keep a plain click from being read as a drag.
- **Import merges, never replaces.** `mergeTransitData()` appends imported lines, skipping ones whose
  name collides, and remaps colliding ids.
- **Filters are view-only.** Search text, the filter chip, and `hiddenLineIds` narrow what is drawn
  and listed; they never touch stored data. `visibleLines()` is the single source for both.
- **UI state lives in the URL.** `line`, `q`, `filter`, and `geom` are synced via `replaceState`, so
  a view is shareable. `restoreFromUrl()` runs before data loads, so a `line` id is re-validated once
  data arrives.
- **Interchange counting is per line, not per stop id.** A stop repeated within one line (a branch
  revisiting it) must not count as an interchange — `interchangeIds()` de-dupes each line's ids first.
- **Two deploy targets.** `.github/workflows/deploy.yml` builds to GitHub Pages; the Vercel adapter
  targets Vercel. Only Vercel supports the SSR API route and Blob persistence.
