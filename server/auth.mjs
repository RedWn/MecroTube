import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const PASSWORD_FILE = path.resolve(process.env.DATA_DIR ?? process.cwd(), 'data', 'admin-password.txt');
const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_S = 60 * 60 * 24; // 24 hours

// Sessions are stateless signed tokens: "<expiry-unix>.<hmac-sha256 hex>".
// The signing key is derived from the admin password file, so tokens survive
// restarts and work across any instance sharing the same data directory.
// Changing the admin password invalidates all existing sessions.

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

function sessionKey() {
  return createHash('sha256').update(`mecrotube-session-v1\0${readPassword() ?? ''}`).digest();
}

function sign(payload) {
  return createHmac('sha256', sessionKey()).update(payload).digest('hex');
}

export function createSession() {
  const payload = String(Math.floor(Date.now() / 1000) + SESSION_TTL_S);
  return `${payload}.${sign(payload)}`;
}

export function isValidSession(token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  let sig;
  try {
    sig = Buffer.from(sigHex, 'hex');
  } catch {
    return false;
  }
  const expected = Buffer.from(sign(payload), 'hex');
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  const expiry = Number(payload);
  if (!Number.isFinite(expiry)) return false;
  return Math.floor(Date.now() / 1000) < expiry;
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
  return createSession();
}

export function logout(_token) {
  // Stateless tokens: nothing to delete server-side.
}

export function sessionFromHeaders(headers) {
  return parseCookies(headers.cookie)[SESSION_COOKIE];
}

export function isAuthenticated(headers) {
  return isValidSession(sessionFromHeaders(headers));
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
