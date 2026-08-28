import { get as getBlob, put as putBlob } from '@vercel/blob';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TransitData } from './types';
import { sampleData } from './sampleData';
import { parseTransitData } from './storage';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_PATH = 'transit-data.json';

/**
 * Local JSON file used in dev (or anywhere Vercel Blob is not configured),
 * so edits still persist while running `astro dev`.
 */
const DATA_FILE = path.resolve(process.cwd(), 'data', 'transit-data.json');

/**
 * Returns the persisted data. On first run (or if the store is missing or
 * corrupt) it seeds the data with the sample data and returns that.
 */
export async function getServerData(): Promise<TransitData> {
  if (BLOB_TOKEN) {
    const fromBlob = await getBlobData();
    if (fromBlob) return fromBlob;
    return writeBlobData(structuredClone(sampleData));
  }
  return getFileData();
}

/** Persists the given data to Vercel Blob (or the local file when unconfigured). */
export async function writeServerData(data: TransitData): Promise<TransitData> {
  if (BLOB_TOKEN) {
    return writeBlobData(data);
  }
  return writeFileData(data);
}

async function getBlobData(): Promise<TransitData | null> {
  const token = BLOB_TOKEN;
  if (!token) return null;
  try {
    const result = await getBlob(BLOB_PATH, { token });
    if (!result) return null;
    const text = await new Response(result.stream).text();
    return parseTransitData(JSON.parse(text));
  } catch (err) {
    console.error('Failed to read transit-data.json from Vercel Blob', err);
    return null;
  }
}

async function writeBlobData(data: TransitData): Promise<TransitData> {
  const token = BLOB_TOKEN!;
  await putBlob(BLOB_PATH, JSON.stringify(data, null, 2), {
    token,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
    access: 'public',
    allowOverwrite: true,
  });
  return data;
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
  const seed = structuredClone(sampleData);
  try {
    return writeFileData(seed);
  } catch (err) {
    console.error('Failed to seed transit-data.json', err);
    return seed;
  }
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