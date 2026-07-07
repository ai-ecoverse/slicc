/**
 * Coverage for the OAuth callback relay routes extracted from index.ts:
 * the HTML callback page plus the POST→GET pending-result handoff used by
 * the Electron overlay flow (where window.opener is unavailable) AND by
 * the worker-served thin-bridge SPA. The POST must fire unconditionally —
 * GitHub does not send a `Cross-Origin-Opener-Policy` header, so
 * `window.opener` stays intact there, and the page's postMessage would
 * silently miss anyway (the receiving listener only accepts messages whose
 * origin matches its own, which never holds cross-origin in thin-bridge
 * mode). The cross-origin round-trip is regression-covered by the
 * bridge-CORS integration block below; the script-execution block covers
 * the branching itself.
 */

import { runInNewContext } from 'node:vm';
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
    // The relay POST must survive window teardown: keepalive + a deferred
    // close that only runs once the fetch settles (or a fallback timer fires).
    expect(html).toContain('keepalive: true');
    expect(html).toContain('.finally(closeWindow)');
    expect(html).toContain('setTimeout(closeWindow');
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

  describe('callback script branching', () => {
    /**
     * Extract the inline `<script>` body from the served HTML and run it in
     * a fresh VM context with stubbed browser globals, so the test exercises
     * the ACTUAL branching logic rather than just the `/api/oauth-result`
     * endpoint pair (which the "204/no-op" bug could still pass even while
     * the script itself never called fetch).
     */
    function runCallbackScript(
      opener: { postMessage: (...args: unknown[]) => void } | null,
      opts: { fetchNeverSettles?: boolean } = {}
    ): {
      fetchCalls: Array<{ url: string; keepalive: unknown; body: unknown }>;
      postMessageCalls: unknown[][];
      timers: Array<{ fn: () => void; delay: number }>;
      sandbox: { closed: boolean };
    } {
      const html = SERVED_HTML;
      const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
      if (!scriptMatch) throw new Error('callback HTML has no <script> block');
      const fetchCalls: Array<{ url: string; keepalive: unknown; body: unknown }> = [];
      const postMessageCalls: unknown[][] = [];
      const timers: Array<{ fn: () => void; delay: number }> = [];
      const sandbox = {
        window: {
          opener: opener
            ? {
                postMessage: (...args: unknown[]) => postMessageCalls.push(args),
              }
            : null,
          close: () => {
            sandbox.closed = true;
          },
        },
        location: { search: '?code=abc123&state=xyz', hash: '' },
        fetch: (url: string, init: { body: unknown; keepalive?: unknown }) => {
          fetchCalls.push({
            url,
            keepalive: init.keepalive,
            body: JSON.parse(init.body as string),
          });
          return opts.fetchNeverSettles ? new Promise(() => {}) : Promise.resolve({ ok: true });
        },
        setTimeout: (fn: () => void, delay: number) => {
          timers.push({ fn, delay });
          return timers.length;
        },
        URLSearchParams,
        console: { error: () => {} },
        closed: false,
      };
      runInNewContext(scriptMatch[1] as string, sandbox);
      return { fetchCalls, postMessageCalls, timers, sandbox };
    }

    let SERVED_HTML = '';

    // Let the fetch().catch().finally(closeWindow) chain drain its microtasks.
    const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

    it('POSTs to /api/oauth-result even when window.opener is present (GitHub: no COOP)', async () => {
      server = await startServer();
      const res = await fetch(`http://localhost:${server.port}/auth/callback?code=abc`);
      SERVED_HTML = await res.text();

      const { fetchCalls, postMessageCalls, sandbox } = runCallbackScript({
        postMessage: () => {},
      });
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe('/api/oauth-result');
      expect(fetchCalls[0]?.keepalive).toBe(true);
      expect(fetchCalls[0]?.body).toMatchObject({ type: 'oauth-callback', code: 'abc123' });
      expect(postMessageCalls).toHaveLength(1);
      // window.close() must be deferred until the POST settles, not fired in
      // the same tick (which would cancel the in-flight relay POST).
      expect(sandbox.closed).toBe(false);
      await flushMicrotasks();
      expect(sandbox.closed).toBe(true);
    });

    it('still POSTs when window.opener is null (Electron overlay)', async () => {
      server = await startServer();
      const res = await fetch(`http://localhost:${server.port}/auth/callback?code=abc`);
      SERVED_HTML = await res.text();

      const { fetchCalls, sandbox } = runCallbackScript(null);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe('/api/oauth-result');
      expect(fetchCalls[0]?.keepalive).toBe(true);
      await flushMicrotasks();
      expect(sandbox.closed).toBe(true);
    });

    it('closes via the fallback timeout if the POST never settles', async () => {
      server = await startServer();
      const res = await fetch(`http://localhost:${server.port}/auth/callback?code=abc`);
      SERVED_HTML = await res.text();

      const { fetchCalls, timers, sandbox } = runCallbackScript(null, {
        fetchNeverSettles: true,
      });
      expect(fetchCalls).toHaveLength(1);
      // The .finally() close never runs because the POST is still in flight.
      await flushMicrotasks();
      expect(sandbox.closed).toBe(false);
      // A single fallback timer was scheduled; firing it closes the window.
      expect(timers).toHaveLength(1);
      timers[0]?.fn();
      expect(sandbox.closed).toBe(true);
    });
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
