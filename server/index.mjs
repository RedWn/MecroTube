import http from 'node:http';
import { checkPassword, isAuthenticated } from './auth.mjs';
import { getServerData, writeServerData, parseTransitData } from './data.mjs';

const PORT = Number(process.env.PORT ?? 4322);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/api/transit' && req.method === 'GET') {
      sendJson(res, 200, getServerData());
      return;
    }

    if (path === '/api/transit' && req.method === 'PUT') {
      if (!isAuthenticated(req.headers)) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      let raw;
      try {
        raw = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      const data = parseTransitData(raw);
      if (!data) {
        sendJson(res, 400, { error: 'Invalid transit data' });
        return;
      }
      writeServerData(data);
      sendJson(res, 200, { ok: true });
      return;
    }

    // Validates a password; on success the client stores it and sends it as
    // a bearer token on subsequent write requests.
    if (path === '/api/admin-auth' && req.method === 'POST') {
      let password = '';
      const contentType = req.headers['content-type'] ?? '';
      try {
        if (contentType.includes('application/json')) {
          const body = JSON.parse(await readBody(req));
          password = body.password ?? '';
        } else {
          const form = new URLSearchParams(await readBody(req));
          password = String(form.get('password') ?? '');
        }
      } catch {
        sendJson(res, 400, { error: 'Invalid request' });
        return;
      }

      if (!checkPassword(password)) {
        sendJson(res, 401, { error: 'Invalid password' });
        return;
      }
      sendJson(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('API error', err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Transit API server listening on http://127.0.0.1:${PORT}`);
});
