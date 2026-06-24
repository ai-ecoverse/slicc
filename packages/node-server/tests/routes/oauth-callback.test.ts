/**
 * Coverage for the OAuth callback relay routes extracted from index.ts:
 * the HTML callback page plus the POST→GET pending-result handoff used by
 * the Electron overlay flow (where window.opener is unavailable) AND by
 * the worker-served thin-bridge SPA (where GitHub's `COOP: same-origin`
 * severs `window.opener`). The cross-origin round-trip is regression-
 * covered by the bridge-CORS integration block below.
 */

import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_TOKEN_HEADER,
  buildCorsHeaders,
  buildPnaPreflightHeaders,
  isLoopbackBridgeOrigin,
  validateBridgeToken,
} from '../../src/bridge-security.js';
import { registerOAuthCallbackRoutes } from '../../src/routes/oauth-callback.js';

interface TestServer {
  port: number;
  close(): Promise<void>;
}

function startServer(): Promise<TestServer> {
  const app = express();
  registerOAuthCallbackRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/**
 * Start a server that mounts the OAuth-callback routes BEHIND the same
 * thin-bridge CORS + bridge-token middleware as `index.ts`. Used to
 * regression-cover the worker-served SPA polling `/api/oauth-result`
 * cross-origin from `https://www.sliccy.ai` while the node-server bridge
 * runs on loopback.
 */
function startCorsServer(bridgeToken: string): Promise<TestServer> {
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
        res.setHeader('Access-Control-Max-Age', '600');
        res.status(204).end();
        return;
      }
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
  registerOAuthCallbackRoutes(app);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

describe('registerOAuthCallbackRoutes', () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  it('serves the callback HTML page', async () => {
    server = await startServer();
    const res = await fetch(`http://localhost:${server.port}/auth/callback?code=abc`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('oauth-callback');
    expect(html).toContain('/api/oauth-result');
  });

  it('relays a posted result to the next GET, then clears it (204)', async () => {
    server = await startServer();
    const base = `http://localhost:${server.port}/api/oauth-result`;

    const post = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUrl: 'https://app/auth?code=xyz', error: undefined }),
    });
    expect(post.status).toBe(200);

    const first = await fetch(base);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ redirectUrl: 'https://app/auth?code=xyz' });

    // Result is one-shot — the second poll is empty.
    const second = await fetch(base);
    expect(second.status).toBe(204);
  });

  it('returns 204 when no result is pending', async () => {
    server = await startServer();
    const res = await fetch(`http://localhost:${server.port}/api/oauth-result`);
    expect(res.status).toBe(204);
  });

  it('accepts (with a warning) a result missing redirectUrl', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await startServer();
    const base = `http://localhost:${server.port}/api/oauth-result`;
    const post = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'access_denied' }),
    });
    expect(post.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    const get = await fetch(base);
    expect(await get.json()).toEqual({ redirectUrl: '', error: 'access_denied' });
  });

  describe('cross-origin thin-bridge round-trip', () => {
    // Use the always-allowlisted prod origin so the test is hermetic and
    // doesn't depend on the BRIDGE_DEV_ALLOWED_ORIGINS env var (which is
    // frozen at module load). The dev origins `http://localhost:8787` and
    // (when configured) the hosted-leader origin both go through the same
    // CORS path; covering the prod origin covers the shared codepath.
    const ORIGIN = 'https://www.sliccy.ai';
    const BRIDGE_TOKEN = 'aabbccdd-1122-3344-5566-778899aabbcc';

    it('OPTIONS preflight emits ACAO + PNA + 204 for the allowlisted origin', async () => {
      server = await startCorsServer(BRIDGE_TOKEN);
      const url = `http://localhost:${server.port}/api/oauth-result`;
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-bridge-token',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain(
        'x-bridge-token'
      );
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    });

    it('POST→GET round-trips the redirect URL through the CORS gate (with bridge token)', async () => {
      server = await startCorsServer(BRIDGE_TOKEN);
      const url = `http://localhost:${server.port}/api/oauth-result`;
      const post = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN,
        },
        body: JSON.stringify({ redirectUrl: 'https://app/auth?code=xyz' }),
      });
      expect(post.status).toBe(200);
      expect(post.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

      const get = await fetch(url, {
        headers: { Origin: ORIGIN, [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN },
      });
      expect(get.status).toBe(200);
      expect(get.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(await get.json()).toEqual({ redirectUrl: 'https://app/auth?code=xyz' });
    });

    it('GET without bridge token from a non-loopback allowlisted origin is rejected (403)', async () => {
      server = await startCorsServer(BRIDGE_TOKEN);
      const res = await fetch(`http://localhost:${server.port}/api/oauth-result`, {
        headers: { Origin: ORIGIN },
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    });

    it('returns 204 (no pending result) for a fresh GET with a valid bridge token', async () => {
      server = await startCorsServer(BRIDGE_TOKEN);
      const res = await fetch(`http://localhost:${server.port}/api/oauth-result`, {
        headers: { Origin: ORIGIN, [BRIDGE_TOKEN_HEADER]: BRIDGE_TOKEN },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    });
  });
});
