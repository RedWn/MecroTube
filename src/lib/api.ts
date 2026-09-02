/**
 * Central API base URL for the MecroTube backend.
 *
 * Configure with the PUBLIC_API_URL environment variable at build time, e.g.:
 *
 *   PUBLIC_API_URL=https://api.example.com npm run build
 *
 * When unset, requests go to `/api` on the same origin (the setup used by the
 * Astro dev proxy and the included nginx.conf).
 */
const configured = import.meta.env.PUBLIC_API_URL as string | undefined;

export const API_BASE = configured ? configured.replace(/\/+$/, '') : '';

export const TRANSIT_API_URL = `${API_BASE}/api/transit`;
export const ADMIN_AUTH_API_URL = `${API_BASE}/api/admin-auth`;
