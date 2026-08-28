import { createClient } from '@vercel/kv';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TransitData } from './types';
import { sampleData } from './sampleData';
import { parseTransitData } from './storage';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY = 'transit-data';

const kv = KV_URL && KV_TOKEN ? createClient({ url: KV_URL, token: KV_TOKEN }) : null;

/**
 * Shared JSON file backing the transit data. Read/written by the server so
 * every visitor sees (and edits) the same data. Used locally and as a
 * fallback when Vercel KV is not configured.
 */
const DATA_FILE = path.resolve(process.cwd(), 'data', 'transit-data.json');

/**
 * Returns the persisted data. On first run (or if the store is missing or
 * corrupt) it seeds the data with the sample data and returns that.
 */
export async function getServerData(): Promise<TransitData> {
  const fromKV = kv ? await getKVData() : null;
  if (fromKV) return fromKV;

  return getFileData();
}

/** Persists the given data, preferring Vercel KV when configured. */
export async function writeServerData(data: TransitData): Promise<TransitData> {
  if (kv) {
    await kv.set<TransitData>(KV_KEY, data);
    return data;
  }
  return writeFileData(data);
}

async function getKVData(): Promise<TransitData | null> {
  try {
    const value = await kv!.get<TransitData>(KV_KEY);
    if (!value) return null;
    return parseTransitData(value);
  } catch (err) {
    console.error('Failed to read transit data from Vercel KV', err);
    return null;
  }
}

function getFileData(): TransitData {
  try {
    if (existsSync(DATA_FILE)) {
      const parsed = parseTransitData(JSON.parse(readFileSync(DATA_FILE, 'utf8')));
      if (parsed) return parsed;
    }
  } catch {
    // fall through to re-seeding
  }
  return writeFileData(structuredClone(sampleData));
}

/** Persists the given data to the shared JSON file (atomically via a temp file). */
function writeFileData(data: TransitData): TransitData {
  const dir = path.dirname(DATA_FILE);
  mkdirSync(dir, { recursive: true });
  const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpFile, DATA_FILE);
  return data;
}