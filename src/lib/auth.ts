/**
 * Admin auth: no sessions, no cookies.
 *
 * The admin password is the only credential. The frontend stores it in
 * localStorage after validating it once against the backend, then sends it
 * as "Authorization: Bearer <password>" on every request that requires auth.
 * The backend checks the header against the password file each time.
 */
import { ADMIN_AUTH_API_URL } from './api';

const STORAGE_KEY = 'admin_password';

export function getPassword(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function forgetPassword(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Validates the password against the backend and stores it on success. */
export async function login(password: string): Promise<boolean> {
  const res = await fetch(ADMIN_AUTH_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    cache: 'no-store',
  });
  if (!res.ok) return false;
  localStorage.setItem(STORAGE_KEY, password);
  return true;
}

/** Headers for requests that require auth. */
export function authHeaders(): Record<string, string> {
  const password = getPassword();
  return password ? { Authorization: `Bearer ${password}` } : {};
}
