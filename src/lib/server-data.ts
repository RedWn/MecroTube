import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { TransitData } from './types';
import { parseTransitData } from './storage';

const DB_FILE = path.resolve(process.cwd(), 'data', 'transit.db');

const EMPTY_DATA: TransitData = { stops: [], lines: [] };

const db = initDb();
const selectData = db.prepare('SELECT payload FROM app_state WHERE id = 1');
const upsertData = db.prepare(
  'INSERT INTO app_state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
);

/** Returns the persisted data, or empty data when nothing has been stored yet. */
export async function getServerData(): Promise<TransitData> {
  try {
    const row = selectData.get() as { payload: string } | undefined;
    if (!row) return EMPTY_DATA;
    return parseTransitData(JSON.parse(row.payload)) ?? EMPTY_DATA;
  } catch (err) {
    console.error('Failed to read transit data from SQLite', err);
    return EMPTY_DATA;
  }
}

export async function writeServerData(data: TransitData): Promise<TransitData> {
  try {
    upsertData.run(JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('Failed to write transit data to SQLite', err);
    throw err;
  }
}

function initDb(): Database.Database {
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
