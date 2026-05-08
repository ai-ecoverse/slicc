import { describe, it, expect } from 'vitest';
import express from 'express';
import { buildLocalApiDescriptor, sliccLinksMiddleware } from '../src/links-middleware.js';

function makeApp() {
  const app = express();
  app.use(sliccLinksMiddleware());
  app.get('/api/runtime-config', (_req, res) => res.json({ ok: true }));
  app.get('/api/handoff/example', (_req, res) => res.json({ ok: true }));
  app.get('/api', (req, res) =>
    res.json(buildLocalApiDescriptor(req.headers.host ?? 'localhost:5710'))
  );
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
    expect(link).toContain('rel="terms-of-service"');
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
