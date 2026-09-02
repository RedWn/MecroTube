import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const PASSWORD_FILE = path.resolve(process.cwd(), 'data', 'admin-password.txt');
const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

const sessions = new Map();

function readPassword() {
  try {
    if (!existsSync(PASSWORD_FILE)) {
      mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true });
      writeFileSync(PASSWORD_FILE, 'changeme\n', { encoding: 'utf8', mode: 0o600 });
      console.warn(`Created default admin password file at ${PASSWORD_FILE}. Change it before deploying.`);
    }
    const password = readFileSync(PASSWORD_FILE, 'utf8').trim();
    return password || null;
  } catch (err) {
    console.error('Failed to read admin password file', err);
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Returns a session token when the password matches, otherwise null. */
export function login(password) {
  const expected = readPassword();
  if (!expected || password !== expected) return null;
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function logout(token) {
  if (token) sessions.delete(token);
}

export function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function sessionFromHeaders(headers) {
  return parseCookies(headers.cookie)[SESSION_COOKIE];
}

export function isAuthenticated(headers) {
  return isValidSession(sessionFromHeaders(headers));
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
