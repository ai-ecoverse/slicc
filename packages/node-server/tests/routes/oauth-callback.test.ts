/**
 * Coverage for the OAuth callback relay routes extracted from index.ts:
 * the HTML callback page plus the POST→GET pending-result handoff used by
 * the Electron overlay flow (where window.opener is unavailable).
 */
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
