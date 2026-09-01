import type { Stop } from './types';

/**
 * Snaps a sequence of stops to real road geometry using OSRM.
 *
 * The public demo server is rate-limited and offers no uptime guarantee, so
 * every failure path falls back to straight lines: a route that can't be
 * fetched still renders, just without road shape. Set PUBLIC_OSRM_URL to
 * point at a self-hosted instance for production use.
 */
const OSRM_BASE =
  import.meta.env.PUBLIC_OSRM_URL ?? 'https://router.project-osrm.org';

/** OSRM rejects very long coordinate lists; keep requests well under the URL limit. */
const MAX_WAYPOINTS = 100;

export type LatLng = [number, number];

/** In-memory cache keyed by the exact stop geometry a route was built from. */
const cache = new Map<string, LatLng[]>();

function cacheKey(coords: LatLng[], loop: boolean): string {
  return `${loop ? 'L' : 'P'}:${coords.map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join(';')}`;
}

/** Straight-line fallback: the stops themselves, in order. */
function straight(coords: LatLng[], loop: boolean): LatLng[] {
  return loop && coords.length > 1 ? [...coords, coords[0]] : coords;
}

/**
 * Returns road-following geometry through the given stops, or straight
 * segments when routing is unavailable. Never throws.
 */
export async function snapToRoads(
  stops: Stop[],
  loop: boolean,
  signal?: AbortSignal,
): Promise<LatLng[]> {
  const coords: LatLng[] = stops.map((s) => [s.lat, s.lng]);
  if (coords.length < 2) return straight(coords, loop);
  if (coords.length > MAX_WAYPOINTS) return straight(coords, loop);

  const key = cacheKey(coords, loop);
  const hit = cache.get(key);
  if (hit) return hit;

  // A loop closes by repeating the first stop as a final waypoint.
  const waypoints = loop ? [...coords, coords[0]] : coords;
  // OSRM takes lng,lat — the reverse of Leaflet's ordering.
  const path = waypoints.map(([lat, lng]) => `${lng},${lat}`).join(';');
  const url = `${OSRM_BASE}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=false`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return straight(coords, loop);
    const body = await res.json();
    if (body?.code !== 'Ok' || !body.routes?.[0]?.geometry?.coordinates) {
      return straight(coords, loop);
    }
    const line: LatLng[] = body.routes[0].geometry.coordinates.map(
      ([lng, lat]: [number, number]): LatLng => [lat, lng],
    );
    if (line.length < 2) return straight(coords, loop);
    cache.set(key, line);
    return line;
  } catch {
    // Aborted, offline, rate-limited, or malformed — straight lines still work.
    return straight(coords, loop);
  }
}

/**
 * Catmull-Rom spline through the given points, used when road snapping is
 * off. Produces smooth curves rather than hard corners at each stop.
 */
export function smoothPath(coords: LatLng[], loop: boolean, segments = 16): LatLng[] {
  if (coords.length < 3) return straight(coords, loop);
  const pts = loop ? [...coords, coords[0]] : coords;
  const at = (i: number): LatLng => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const out: LatLng[] = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
