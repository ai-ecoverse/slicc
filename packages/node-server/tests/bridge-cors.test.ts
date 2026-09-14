import { createServer, type Server } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isLoopbackBridgeOrigin,
  preflightMaxAge,
  shouldMountThinBridgeCors,
  validateBridgeToken,
} from '../src/bridge-security.js';

const PROD_ORIGIN = 'https://www.sliccy.ai';
const BRIDGE_TOKEN = 'aabbccdd-1122-3344-5566-778899aabbcc';

let server: Server;
let base = '';

beforeEach(async () => {
  const app = express();

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
    if (cors) {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }
    if (req.method === 'OPTIONS') {
      if (cors) {
        for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
        res.setHeader('Access-Control-Max-Age', preflightMaxAge(req.path));
        res.status(204).end();
        return;
      }
    }
    if (
      cors &&
      req.path.startsWith('/api/') &&
      !isLoopbackBridgeOrigin(origin) &&
      !validateBridgeToken(req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()], BRIDGE_TOKEN)
    ) {
      res.status(403).json({ error: 'bridge-token-required' });
      return;
    }
    next();
  });
  app.get('/api/hostfs/list', (_req, res) => {
    res.json({ entries: [] });
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
      headers: { Origin: PROD_ORIGIN, [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin, Access-Control-Request-Headers');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reflects /api/fetch-proxy custom request headers on preflight', async () => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: PROD_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-target-url, x-proxy-cookie, anthropic-version',
      },
    });
    expect(res.status).toBe(204);
    const allow = res.headers.get('access-control-allow-headers') ?? '';
    expect(allow).toContain('X-Target-URL');
    expect(allow).toContain('X-Proxy-Cookie');

    expect(allow).toContain('anthropic-version');
  });

  it('omits CORS headers for non-allowlisted origins', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects cross-origin /api/* requests missing the bridge token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: PROD_ORIGIN },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'bridge-token-required' });
  });

  it('rejects cross-origin /api/* requests with a wrong bridge token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: PROD_ORIGIN, [BRIDGE_TOKEN_HEADER]: 'not-the-token' },
    });
    expect(res.status).toBe(403);
  });

  it('does not gate same-origin (no Origin) requests on the bridge token', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not gate loopback allowlisted origins on the bridge token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: 'http://localhost:5710' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers OPTIONS preflight without requiring the bridge token', async () => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: {
        Origin: PROD_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': `${BRIDGE_TOKEN_HEADER}, content-type`,
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Bridge-Token');
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

  it("gives hostfs preflights Chrome's cap so one covers the whole session", async () => {
    const res = await fetch(`${base}/api/hostfs`, {
      method: 'OPTIONS',
      headers: { Origin: PROD_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-max-age')).toBe('7200');
  });

  it('does not short-circuit OPTIONS from non-allowlisted origins', async () => {
    const res = await fetch(`${base}/api/ping`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(res.status).not.toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBeNull();
  });
});

describe('thin-bridge CORS mount gate (/api/runtime-config)', () => {
  let gateServer: Server;
  let gateBase = '';

  function startGateServer(thinBridgeMode: boolean, bridgeToken: string | null): Promise<void> {
    const app = express();

    if (shouldMountThinBridgeCors(thinBridgeMode, bridgeToken)) {
      app.use((req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
        if (cors) {
          for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
        }
        if (req.method === 'OPTIONS' && cors) {
          for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
          res.setHeader('Access-Control-Max-Age', preflightMaxAge(req.path));
          res.status(204).end();
          return;
        }
        if (
          cors &&
          req.path.startsWith('/api/') &&
          !isLoopbackBridgeOrigin(origin) &&
          !validateBridgeToken(req.headers[BRIDGE_TOKEN_HEADER.toLowerCase()], bridgeToken)
        ) {
          res.status(403).json({ error: 'bridge-token-required' });
          return;
        }
        next();
      });
    }
    app.get('/api/runtime-config', (_req, res) => {
      res.json({ trayJoinUrl: null });
    });
    gateServer = createServer(app);
    return new Promise<void>((r) => {
      gateServer.listen(0, '127.0.0.1', () => {
        const addr = gateServer.address();
        gateBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        r();
      });
    });
  }

  afterEach(async () => {
    if (gateServer) await new Promise<void>((r) => gateServer.close(() => r()));
  });

  it('attaches ACAO to /api/runtime-config when a token is present even with THIN_BRIDGE_MODE false', async () => {
    await startGateServer(false, BRIDGE_TOKEN);
    const res = await fetch(`${gateBase}/api/runtime-config`, {
      headers: { Origin: PROD_ORIGIN, [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PROD_ORIGIN);
  });

  it('omits ACAO on /api/runtime-config in a legacy mode with no bridge token', async () => {
    await startGateServer(false, null);
    const res = await fetch(`${gateBase}/api/runtime-config`, {
      headers: { Origin: PROD_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
