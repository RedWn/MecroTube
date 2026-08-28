import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TransitData } from './types';
import { sampleData } from './sampleData';
import { parseTransitData } from './storage';

/**
 * Shared JSON file backing the transit data. Read/written by the server so
 * every visitor sees (and edits) the same data.
 */
const DATA_FILE = path.resolve(process.cwd(), 'data', 'transit-data.json');

/**
 * Returns the persisted data. On first run (or if the file is missing or
 * corrupt) it seeds the file with the sample data and returns that.
 */
export function getServerData(): TransitData {
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = parseTransitData(JSON.parse(readFileSync(DATA_FILE, 'utf8')));
      if (parsed) return parsed;
    }
  } catch {
    // fall through to re-seeding
  }
  return writeServerData(structuredClone(sampleData));
}

/** Persists the given data to the shared JSON file (atomically via a temp file). */
export function writeServerData(data: TransitData): TransitData {
  const dir = path.dirname(DATA_FILE);
  mkdirSync(dir, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpFile, DATA_FILE);
  return data;
}