// node:http fake cup for lick-back script tests: GET /api/status, /api/targets,
// /api/vfs/read, the /api/lickback SSE drain; POST claim/heartbeat/reply,
// /api/vfs/list, /api/shell/exec. `received` records request bodies for
// assertions. Routing is split into handleGet/handlePost helpers so each stays
// under the cognitive-complexity gate.
// tva
import { createServer } from 'node:http';

function sendJson(res, status, json) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(json));
}

/** GET routes. Returns true once it has fully handled (and ended) the response. */
function handleGet(req, res, url, handlers, received) {
  if (url.startsWith('/api/status')) {
    received.statusHits++;
    sendJson(res, 200, { cup: handlers.statusCup !== false, servePort: 0, pid: 1 });
    return true;
  }
  if (url.startsWith('/api/targets')) {
    // Bridge-ready signal: 200 once the browser is connected + the handler registered.
    sendJson(res, handlers.targetsStatus ?? 200, handlers.targets ?? []);
    return true;
  }
  if (url.startsWith('/api/vfs/read')) {
    // handlers.vfs maps path -> content; a 404 simulates a missing file.
    const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
    const content = handlers.vfs?.[path];
    if (content === undefined) sendJson(res, 404, { error: 'not found' });
    else sendJson(res, 200, { content });
    return true;
  }
  if (url.startsWith('/api/lickback')) {
    if (handlers.sseStatus && handlers.sseStatus !== 200) {
      sendJson(res, handlers.sseStatus, { error: 'owned' });
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
    for (const f of handlers.frames ?? []) res.write(`data: ${JSON.stringify(f)}\n\n`);
    return true; // stay open
  }
  return false;
}

/** POST routes (body already parsed). Always ends the response. */
function handlePost(res, url, body, session, handlers, received) {
  if (url.startsWith('/api/lickback/claim')) {
    received.claims.push({ body, session });
    const r = handlers.claim ?? { status: 200, json: { owner: session, leaseMs: 45_000 } };
    sendJson(res, r.status, r.json ?? {});
  } else if (url.startsWith('/api/lickback/heartbeat')) {
    received.heartbeats.push({ body, session });
    const r = handlers.heartbeat ?? { status: 200, json: { ok: true } };
    sendJson(res, r.status, r.json ?? {});
  } else if (url.startsWith('/api/lickback/reply')) {
    received.replies.push({ body, session });
    const r = handlers.reply ?? { status: 200, json: { ok: true } };
    sendJson(res, r.status, r.json ?? {});
  } else if (url.startsWith('/api/vfs/list')) {
    sendJson(res, 200, handlers.vfsList ?? []);
  } else if (url.startsWith('/api/shell/exec')) {
    received.execs.push({ body, session });
    // handlers.exec(command) -> { stdout?, stderr?, exitCode? }; default empty ok.
    const out = typeof handlers.exec === 'function' ? handlers.exec(body.command) : {};
    sendJson(res, 200, { stdout: '', stderr: '', exitCode: 0, ...out });
  } else {
    sendJson(res, 404, {});
  }
}

export async function startFakeCup(handlers = {}) {
  const received = { claims: [], heartbeats: [], replies: [], execs: [], statusHits: 0 };

  const server = createServer((req, res) => {
    const url = req.url || '';
    const session = req.headers['x-slicc-session'];
    if (req.method === 'GET' && handleGet(req, res, url, handlers, received)) return;

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
      handlePost(res, url, body, session, handlers, received);
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
