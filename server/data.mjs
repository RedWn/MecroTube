import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve(process.cwd(), 'data', 'transit.db');

const EMPTY_DATA = { stops: [], lines: [] };

/**
 * Validates that a parsed JSON value has the shape of TransitData.
 * Returns the data (unchanged) if valid, otherwise null.
 */
export function parseTransitData(value) {
  if (!value || typeof value !== 'object') return null;
  const data = value;
  if (!Array.isArray(data.stops) || !Array.isArray(data.lines)) return null;

  const stopsValid = data.stops.every(
    (s) =>
      s &&
      typeof s === 'object' &&
      typeof s.id === 'string' &&
      typeof s.nameEn === 'string' &&
      typeof s.nameAr === 'string' &&
      typeof s.lat === 'number' &&
      typeof s.lng === 'number',
  );
  if (!stopsValid) return null;

  const linesValid = data.lines.every(
    (l) =>
      l &&
      typeof l === 'object' &&
      typeof l.id === 'string' &&
      typeof l.nameEn === 'string' &&
      typeof l.nameAr === 'string' &&
      typeof l.color === 'string' &&
      typeof l.loop === 'boolean' &&
      Array.isArray(l.stopIds) &&
      l.stopIds.every((id) => typeof id === 'string'),
  );
  if (!linesValid) return null;

  return data;
}

const db = initDb();
const selectData = db.prepare('SELECT payload FROM app_state WHERE id = 1');
const upsertData = db.prepare(
  'INSERT INTO app_state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
);

/** Returns the persisted data, or empty data when nothing has been stored yet. */
export function getServerData() {
  try {
    const row = selectData.get();
    if (!row) return EMPTY_DATA;
    return parseTransitData(JSON.parse(row.payload)) ?? EMPTY_DATA;
  } catch (err) {
    console.error('Failed to read transit data from SQLite', err);
    return EMPTY_DATA;
  }
}

export function writeServerData(data) {
  try {
    upsertData.run(JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('Failed to write transit data to SQLite', err);
    throw err;
  }
}

function initDb() {
  const dir = path.dirname(DB_FILE);
  mkdirSync(dir, { recursive: true });
  const database = new Database(DB_FILE);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    )
  `);
  return database;
}
