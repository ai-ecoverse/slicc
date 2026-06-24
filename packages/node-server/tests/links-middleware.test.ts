import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  buildLocalApiDescriptor,
  buildStatusPayload,
  sliccLinksMiddleware,
} from '../src/links-middleware.js';

function makeApp() {
  const app = express();
  app.use(sliccLinksMiddleware());
  app.get('/api/runtime-config', (_req, res) => res.json({ ok: true }));
  app.get('/api/handoff/example', (_req, res) => res.json({ ok: true }));
  app.get('/api', (req, res) =>
    res.json(buildLocalApiDescriptor(req.headers.host ?? 'localhost:5710'))
  );
  // Stand-in for the real `/api/fetch-proxy` handler — the middleware should
  // not decorate this response since it relays a third-party body.
  app.all('/api/fetch-proxy', (_req, res) => res.json({ relayed: true }));
  app.all('/api/fetch-proxy/sub', (_req, res) => res.json({ relayed: true }));
  app.get('/non-api', (_req, res) => res.json({ ok: true }));
  return app;
}

async function fetchInProcess(app: express.Express, path: string): Promise<Response> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;
    return await fetch(`http://localhost:${port}${path}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('sliccLinksMiddleware', () => {
  it('attaches the SLICC standard Link rels to /api responses', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api/runtime-config');
    expect(response.status).toBe(200);
    const link = response.headers.get('link') ?? '';
    expect(link).toContain('rel="service-desc"');
    expect(link).toContain('rel="service-doc"');
    expect(link).toContain('rel="status"');
    expect(link).toContain('rel="terms-of-service"');
  });

  it('advertises GET /api/status via the status rel on /api responses', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api/runtime-config');
    const link = response.headers.get('link') ?? '';
    expect(link).toMatch(/<http:\/\/localhost:\d+\/api\/status>; rel="status"/);
  });

  it('attaches Link rels to /api descriptor itself', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api');
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toContain('service-desc');
  });

  it('attaches Link rels to deeper /api/* paths', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api/handoff/example');
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toContain('service-desc');
  });

  it('does NOT attach Link to non-/api paths', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/non-api');
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toBeNull();
  });

  it('does NOT decorate /api/fetch-proxy (transparent relay)', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api/fetch-proxy');
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toBeNull();
  });

  it('does NOT decorate paths under /api/fetch-proxy/', async () => {
    const app = makeApp();
    const response = await fetchInProcess(app, '/api/fetch-proxy/sub');
    expect(response.status).toBe(200);
    expect(response.headers.get('link')).toBeNull();
  });

  it('bails out when an upstream middleware has already sent headers', async () => {
    // Drive the middleware directly with a stub Response whose `headersSent`
    // is already true — the middleware must call `next()` without touching
    // the headers, matching the documented "skips when upstream wrote
    // headers" contract.
    const middleware = sliccLinksMiddleware();
    const appended: Array<[string, string]> = [];
    const req = {
      path: '/api/runtime-config',
      headers: { host: 'localhost:5710' },
    } as unknown as Parameters<typeof middleware>[0];
    const res = {
      headersSent: true,
      append: (name: string, value: string) => {
        appended.push([name, value]);
      },
    } as unknown as Parameters<typeof middleware>[1];
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(appended).toEqual([]);
  });
});

describe('buildLocalApiDescriptor', () => {
  it('produces a discoverable JSON shape with the localhost origin baked in', () => {
    const descriptor = buildLocalApiDescriptor('localhost:5710') as {
      service: string;
      endpoints: Array<{ anchor: string; method: string }>;
    };
    expect(descriptor.service).toBe('slicc-node-server');
    const anchors = descriptor.endpoints.map((e) => e.anchor);
    expect(anchors).toContain('http://localhost:5710/api/handoff');
    expect(anchors).toContain('http://localhost:5710/api/runtime-config');
    expect(anchors).toContain('http://localhost:5710/api/status');
  });

  it('describes the new /api/handoff verb-shape payload (not the legacy sliccHeader)', () => {
    const descriptor = buildLocalApiDescriptor('localhost:5710') as {
      endpoints: Array<{ anchor: string; description: string }>;
    };
    const handoff = descriptor.endpoints.find((e) => e.anchor.endsWith('/api/handoff'));
    expect(handoff).toBeTruthy();
    expect(handoff!.description).toContain('verb');
    expect(handoff!.description).toContain('target');
    expect(handoff!.description).not.toContain('sliccHeader');
  });
});

describe('buildStatusPayload', () => {
  it('exposes the substrate marker, servePort and pid so a second session can detect+attach', () => {
    const payload = buildStatusPayload({
      substrate: true,
      servePort: 5710,
      pid: 4242,
      timestamp: '2026-06-25T10:00:00.000Z',
    });
    expect(payload).toEqual({
      status: 'ok',
      service: 'slicc-node-server',
      timestamp: '2026-06-25T10:00:00.000Z',
      substrate: true,
      servePort: 5710,
      pid: 4242,
    });
  });

  it('reports substrate:false outside substrate mode (so a plain dev leader is not mistaken for one)', () => {
    const payload = buildStatusPayload({
      substrate: false,
      servePort: 5711,
      pid: 99,
      timestamp: '2026-06-25T10:00:00.000Z',
    });
    expect(payload.substrate).toBe(false);
    expect(payload.servePort).toBe(5711);
  });
});
