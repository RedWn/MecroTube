import type { APIRoute } from 'astro';
import { login, logout, sessionCookieHeader, clearSessionCookieHeader, sessionFromRequest } from '../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let password = '';
  let to = '/admin';
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { password?: string; to?: string };
      password = body.password ?? '';
      if (typeof body.to === 'string') to = body.to;
    } else {
      const form = await request.formData();
      password = String(form.get('password') ?? '');
      to = String(form.get('to') ?? to);
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = login(password);
  if (!token) {
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only allow same-site relative redirects.
  if (!to.startsWith('/')) to = '/admin';
  return new Response(JSON.stringify({ ok: true, to }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookieHeader(token),
    },
  });
};

export const DELETE: APIRoute = async ({ request }) => {
  logout(sessionFromRequest(request));
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookieHeader(),
    },
  });
};
