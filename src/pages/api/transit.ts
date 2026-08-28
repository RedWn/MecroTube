import type { APIRoute } from 'astro';
import { getServerData, writeServerData } from '../../lib/server-data';
import { parseTransitData } from '../../lib/storage';

export const prerender = false;

const jsonHeaders = { 'Content-Type': 'application/json' };

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(await getServerData(), null, 2), { headers: jsonHeaders });
};

export const PUT: APIRoute = async ({ request }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  const data = parseTransitData(raw);
  if (!data) {
    return new Response(JSON.stringify({ error: 'Invalid transit data' }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  await writeServerData(data);
  return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
};