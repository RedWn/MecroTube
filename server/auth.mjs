import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PASSWORD_FILE = path.resolve(process.env.DATA_DIR ?? process.cwd(), 'data', 'admin-password.txt');

// There are no sessions. The admin password is sent directly as a bearer
// token: "Authorization: Bearer <password>", validated against the password
// file on every request. The file is re-read each time, so password changes
// take effect immediately.

export function readPassword() {
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

export function checkPassword(password) {
  const expected = readPassword();
  return Boolean(expected) && password === expected;
}

export function isAuthenticated(headers) {
  const auth = headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  return checkPassword(auth.slice('Bearer '.length));
}
