/**
 * Coverage for the production static-serving branch of attachUiServing: the
 * Cache-Control buckets (no-cache default, immutable assets, no-store service
 * workers) and the SPA fallback. The Vite dev branch is exercised by the real
 * `npm run dev` flow, not here.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachUiServing } from '../src/ui-serving.js';

let uiDir: string;
let server: Server;
let base = '';

beforeEach(async () => {
  uiDir = join(tmpdir(), `slicc-ui-${randomUUID()}`);
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!DOCTYPE html><div id="app"></div>');
  writeFileSync(join(uiDir, 'assets', 'app-deadbeef.js'), 'console.log(1)');
  writeFileSync(join(uiDir, 'llm-proxy-sw.js'), '// sw');

  const app = express();
  await attachUiServing(app, createServer(), {
    devMode: false,
    hosted: false,
    serveOrigin: 'http://localhost:0',
    uiDir,
  });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(uiDir, { recursive: true, force: true });
});

describe('attachUiServing (static)', () => {
  it('serves index.html with no-cache', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves content-hashed assets as immutable', async () => {
    const res = await fetch(`${base}/assets/app-deadbeef.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('serves service workers as no-store with Service-Worker-Allowed', async () => {
    const res = await fetch(`${base}/llm-proxy-sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('service-worker-allowed')).toBe('/');
  });

  it('falls back to index.html for unknown SPA routes', async () => {
    const res = await fetch(`${base}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<div id="app"></div>');
  });
});
