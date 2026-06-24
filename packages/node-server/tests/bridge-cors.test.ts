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

import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isLoopbackBridgeOrigin,
  shouldMountThinBridgeCors,
  validateBridgeToken,
} from '../src/bridge-security.js';

const PROD_ORIGIN = 'https://www.sliccy.ai';
const BRIDGE_TOKEN = 'aabbccdd-1122-3344-5566-778899aabbcc';

let server: Server;
let base = '';

beforeEach(async () => {
  const app = express();
  // Mirror `createThinBridgeCorsMiddleware` from `index.ts`. The middleware
  // there is closure-scoped over `bridgeToken`, so we re-create the same
  // shape here against the public helpers — if those helpers change, both
  // the live wiring and the test update together.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
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
    // Reflected upstream header is preserved with its requested casing.
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
    // sliccy.ai is allowlisted but the per-process token is the auth
    // factor. A script on sliccy.ai with no token must NOT reach /api.
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
    // curl-style callers and same-origin GETs send no Origin header.
    // The token requirement is a top-up over the origin allowlist; no
    // allowlisted origin → no token requirement.
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not gate loopback allowlisted origins on the bridge token', async () => {
    // The locally-served OAuth callback page at
    // `http://localhost:5710/auth/callback` POSTs to `/api/oauth-result`
    // from a loopback origin without a token — it originates from this
    // same server.
    const res = await fetch(`${base}/api/ping`, {
      headers: { Origin: 'http://localhost:5710' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers OPTIONS preflight without requiring the bridge token', async () => {
    // Browsers strip custom headers (including X-Bridge-Token) from
    // preflights, so OPTIONS must short-circuit before the gate.
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

/**
 * Regression for BUG-F4: the CORS middleware mount must be gated on
 * `shouldMountThinBridgeCors`, not on `THIN_BRIDGE_MODE` alone. Under
 * `--electron` the follower has `THIN_BRIDGE_MODE === false` but a forwarded
 * `SLICC_BRIDGE_TOKEN` ⇒ `state.bridgeToken` non-null; the cross-origin
 * overlay's `/api/runtime-config` fetch then needs `access-control-*`
 * headers. This drives the exact `index.ts` mount wiring against a real
 * `/api/runtime-config` route.
 */
describe('thin-bridge CORS mount gate (/api/runtime-config)', () => {
  let gateServer: Server;
  let gateBase = '';

  function startGateServer(thinBridgeMode: boolean, bridgeToken: string | null): Promise<void> {
    const app = express();
    // Mirror `index.ts`: mount the CORS middleware only when the gate says so.
    if (shouldMountThinBridgeCors(thinBridgeMode, bridgeToken)) {
      app.use((req: Request, res: Response, next: NextFunction) => {
        const origin = req.headers.origin;
        const cors = buildCorsHeaders(origin, req.headers['access-control-request-headers']);
        if (cors) {
          for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
        }
        if (req.method === 'OPTIONS' && cors) {
          for (const [k, v] of Object.entries(buildPnaPreflightHeaders())) res.setHeader(k, v);
          res.setHeader('Access-Control-Max-Age', '600');
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
