import type { TransitData } from './types';

/**
 * Validates that a parsed JSON value has the shape of TransitData.
 * Returns the data (unchanged) if valid, otherwise null.
 */
export function parseTransitData(value: unknown): TransitData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<TransitData>;
  if (!Array.isArray(data.stops) || !Array.isArray(data.lines)) return null;

  const stopsValid = data.stops.every(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof (s as any).id === 'string' &&
      typeof (s as any).nameEn === 'string' &&
      typeof (s as any).nameAr === 'string' &&
      typeof (s as any).lat === 'number' &&
      typeof (s as any).lng === 'number',
  );
  if (!stopsValid) return null;

  const linesValid = data.lines.every(
    (l) =>
      l &&
      typeof l === 'object' &&
      typeof (l as any).id === 'string' &&
      typeof (l as any).nameEn === 'string' &&
      typeof (l as any).nameAr === 'string' &&
      typeof (l as any).color === 'string' &&
      typeof (l as any).loop === 'boolean' &&
      Array.isArray((l as any).stopIds) &&
      (l as any).stopIds.every((id: unknown) => typeof id === 'string'),
  );
  if (!linesValid) return null;

  return data as TransitData;
}

/** Serializes the given data to a pretty-printed JSON string for export. */
export function exportDataAsJson(data: TransitData): string {
  return JSON.stringify(data, null, 2);
}

function uniqueId(prefix: string, taken: Set<string>): string {
  let id = `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  while (taken.has(id)) id = `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
  taken.add(id);
  return id;
}

/**
 * Merges imported data into the current data, appending its stops and lines
 * rather than replacing anything. If an imported stop/line id collides with
 * an id already in use, it is given a new unique id (and any references to
 * it, e.g. a line's stopIds, are updated accordingly) so nothing is
 * overwritten or corrupted.
 */
export function mergeTransitData(current: TransitData, imported: TransitData): TransitData {
  const stopIds = new Set(current.stops.map((s) => s.id));
  const lineIds = new Set(current.lines.map((l) => l.id));

  const stopIdMap = new Map<string, string>();
  const mergedStops = [
    ...current.stops,
    ...imported.stops.map((stop) => {
      const id = stopIds.has(stop.id) ? uniqueId('stop', stopIds) : (stopIds.add(stop.id), stop.id);
      stopIdMap.set(stop.id, id);
      return { ...stop, id };
    }),
  ];

  const mergedLines = [
    ...current.lines,
    ...imported.lines.map((line) => {
      const id = lineIds.has(line.id) ? uniqueId('line', lineIds) : (lineIds.add(line.id), line.id);
      return {
        ...line,
        id,
        stopIds: line.stopIds.map((sid) => stopIdMap.get(sid) ?? sid),
      };
    }),
  ];

  return { stops: mergedStops, lines: mergedLines };
}
