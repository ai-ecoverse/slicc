/**
 * Verifies the thin-bridge CORS + PNA middleware shape against a real Express
 * pipeline. The middleware itself is inlined in `index.ts` (it's tiny and
 * threaded through closure-scoped `THIN_BRIDGE_MODE`), so this test
 * re-creates the exact same middleware against the same pure helpers — if
 * the helpers change, both tests + the live wiring update together.
 */
import { createServer, type Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCorsHeaders, buildPnaPreflightHeaders } from '../src/bridge-security.js';

const PROD_ORIGIN = 'https://www.sliccy.ai';

let server: Server;
let base = '';

beforeEach(async () => {
  const app = express();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cors = buildCorsHeaders(req.headers.origin);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS') {
      if (cors) {
        for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
    }
    next();
  });
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true });
  });

  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('thin-bridge CORS + PNA middleware', () => {
  it('attaches CORS headers to /api responses from an allowlisted origin', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: PROD_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('omits CORS headers for non-allowlisted origins', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers OPTIONS preflight with 204 + PNA opt-in for allowlisted origin', async () => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: PROD_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });

  it('does not short-circuit OPTIONS from non-allowlisted origins', async () => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });
    // Express default OPTIONS handler responds with 200 + Allow, not 204
    // with PNA — verifies the preflight short-circuit only fires when the
    // origin is in the allowlist.
    expect(res.status).not.toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBeNull();
  });
});
