import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FETCH_PROXY_SKIP_HEADERS } from '../src/fetch-proxy-headers.js';

/**
 * Test harness mirroring the production express.json() type-predicate.
 * Production wires the same predicate at packages/node-server/src/index.ts
 * around the global `app.use(express.json(...))` call. Keep them in sync.
 */
function buildApp(): Express {
  const app = express();
  app.use(
    express.json({
      limit: '50mb',
      type: (req) =>
        req.headers['x-slicc-raw-body'] !== '1' &&
        (req.headers['content-type'] ?? '').includes('application/json'),
    })
  );
  app.post('/echo', (req, res) => {
    // If express.json consumed the body (predicate let it through), the
    // stream is drained — `req.on('end', ...)` would never fire. Short-
    // circuit on req.body here.
    if (req.body && Object.keys(req.body).length > 0) {
      res.json({ rawHex: '', parsed: req.body });
      return;
    }
    // Otherwise collect raw chunks (predicate skipped parsing).
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      res.json({ rawHex: raw.toString('hex'), parsed: null });
    });
  });
  return app;
}

describe('express.json with X-Slicc-Raw-Body bypass', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = buildApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('parses JSON normally without the bypass header', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const data = (await res.json()) as { rawHex: string; parsed: unknown };
    // express.json consumed the body, so when the handler reads `req` on
    // 'data' there is nothing left.
    expect(data.rawHex).toBe('');
    expect(data.parsed).toEqual({ hello: 'world' });
  });

  it('preserves raw bytes when X-Slicc-Raw-Body: 1 is set', async () => {
    // Construct bytes that would NOT survive JSON re-serialization:
    // a payload with whitespace and key-order that JSON.stringify normalizes.
    const raw = '{"b":2,  "a":1}';
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slicc-Raw-Body': '1',
      },
      body: raw,
    });
    const data = (await res.json()) as { rawHex: string; parsed: unknown };
    expect(Buffer.from(data.rawHex, 'hex').toString()).toBe(raw);
    expect(data.parsed).toBeNull();
  });
});

describe('FETCH_PROXY_SKIP_HEADERS contract', () => {
  it('contains the X-Slicc-Raw-Body internal marker so it does not leak upstream', () => {
    expect(FETCH_PROXY_SKIP_HEADERS.has('x-slicc-raw-body')).toBe(true);
  });

  it('contains the standard hop-by-hop and proxy-internal headers', () => {
    for (const header of [
      'host',
      'connection',
      'x-target-url',
      'content-length',
      'transfer-encoding',
      'x-proxy-cookie',
      'x-proxy-origin',
      'x-proxy-referer',
    ]) {
      expect(FETCH_PROXY_SKIP_HEADERS.has(header)).toBe(true);
    }
  });

  it('does not skip headers that should be forwarded (sanity)', () => {
    for (const header of ['authorization', 'x-amz-date', 'x-amz-content-sha256', 'content-type']) {
      expect(FETCH_PROXY_SKIP_HEADERS.has(header)).toBe(false);
    }
  });
});
