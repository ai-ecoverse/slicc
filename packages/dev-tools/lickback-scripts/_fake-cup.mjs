// node:http fake cup for lick-back script tests: GET /api/status, POST claim/
// heartbeat/reply, and a GET /api/lickback SSE that emits preset frames then
// stays open. `received` records request bodies for assertions.
// tva
import { createServer } from 'node:http';

export async function startFakeCup(handlers = {}) {
  const received = { claims: [], heartbeats: [], replies: [], statusHits: 0 };

  const server = createServer((req, res) => {
    const url = req.url || '';
    const session = req.headers['x-slicc-session'];

    if (req.method === 'GET' && url.startsWith('/api/status')) {
      received.statusHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ cup: handlers.statusCup !== false, servePort: 0, pid: 1 }));
      return;
    }

    if (req.method === 'GET' && url.startsWith('/api/lickback')) {
      if (handlers.sseStatus && handlers.sseStatus !== 200) {
        res.statusCode = handlers.sseStatus;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'owned' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.flushHeaders?.();
      for (const f of handlers.frames ?? []) res.write(`data: ${JSON.stringify(f)}\n\n`);
      return; // stay open
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
      const reply = (status, json) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
      };
      if (url.startsWith('/api/lickback/claim')) {
        received.claims.push({ body, session });
        const r = handlers.claim ?? { status: 200, json: { owner: session, leaseMs: 45_000 } };
        reply(r.status, r.json ?? {});
      } else if (url.startsWith('/api/lickback/heartbeat')) {
        received.heartbeats.push({ body, session });
        const r = handlers.heartbeat ?? { status: 200, json: { ok: true } };
        reply(r.status, r.json ?? {});
      } else if (url.startsWith('/api/lickback/reply')) {
        received.replies.push({ body, session });
        reply(200, { ok: true });
      } else {
        reply(404, {});
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}
