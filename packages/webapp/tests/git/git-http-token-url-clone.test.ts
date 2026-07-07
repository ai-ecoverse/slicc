/**
 * Token-in-URL clone regression — end-to-end through `createGitHttpClient` /
 * proxied-fetch.
 *
 * Locks in that `git clone https://x-access-token:<masked>@github.com/owner/repo`
 * reaches the fetch-proxy layer with the masked-credential URL intact, so the
 * existing URL-credentials unmask path in node-server / swift-server / the
 * extension SW is the one that runs. Mirrors the
 * `packages/chrome-extension/tests/fetch-proxy-shared.test.ts` "URL with
 * masked cred" pattern, adapted to the isomorphic-git http surface.
 */

import type { GitHttpRequest } from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Synthetic masked sentinel — the real value is opaque to the http client;
// it just has to survive the round-trip from the caller into the fetch-proxy
// layer untouched so the proxy can unmask it.
const MASKED = 'MASK_abc123def456abc123def456';
const CLONE_URL = `https://x-access-token:${MASKED}@github.com/owner/repo.git/info/refs?service=git-upload-pack`;

describe('git-http — token-in-URL clone reaches the fetch-proxy unmask path', () => {
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;
    // `git-http.ts` caches a module-scoped `proxiedFetch` singleton on first
    // call. Reset the module graph so each test picks up a fresh
    // `createProxiedFetch()` against the per-test `chrome` global.
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    if (originalFetch) {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
    vi.restoreAllMocks();
  });

  it('CLI mode: masked-cred URL is forwarded to /api/fetch-proxy via X-Target-URL', async () => {
    // CLI mode — no chrome runtime.
    (globalThis as { chrome?: unknown }).chrome = undefined;

    const mockFetch = vi.fn(
      async () =>
        new Response('refs response', {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        })
    );
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      mockFetch as unknown as typeof globalThis.fetch;

    const { createGitHttpClient } = await import('../../src/git/git-http.js');
    const client = createGitHttpClient();
    const req: GitHttpRequest = {
      url: CLONE_URL,
      method: 'GET',
      headers: { 'user-agent': 'git/isomorphic-git' },
    };

    const resp = await client.request(req);

    // The proxy endpoint is the one that runs — not a direct fetch of the
    // upstream URL.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [proxyUrl, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(proxyUrl).toBe('/api/fetch-proxy');

    // The full masked-cred URL — userinfo segment and all — survives intact
    // on `X-Target-URL` so the proxy's `extractAndUnmaskUrlCredentials` path
    // can strip the userinfo and synthesize a Basic Authorization with the
    // real PAT.
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Target-URL']).toBe(CLONE_URL);
    expect(headers['X-Target-URL']).toContain(`x-access-token:${MASKED}@`);
    expect(headers['X-Target-URL']).toMatch(/^https:\/\/x-access-token:/);

    expect(resp.statusCode).toBe(200);
  });

  it('Extension mode: masked-cred URL is posted to the fetch-proxy.fetch Port', async () => {
    // Extension mode — a chrome.runtime with `connect` and an `id` triggers
    // the Port-based branch in `createProxiedFetch`.
    const postedMessages: unknown[] = [];
    const msgListeners: ((m: unknown) => void)[] = [];
    const port = {
      postMessage: (msg: unknown) => {
        postedMessages.push(msg);
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: (m: unknown) => void) => msgListeners.push(fn) },
      onDisconnect: { addListener: vi.fn() },
    };
    const connect = vi.fn(() => port);
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect, id: 'test-extension-id' },
    };

    const { createGitHttpClient } = await import('../../src/git/git-http.js');
    const client = createGitHttpClient();
    const req: GitHttpRequest = {
      url: CLONE_URL,
      method: 'GET',
      headers: { 'user-agent': 'git/isomorphic-git' },
    };

    const requestPromise = client.request(req);

    // Allow `extensionPortFetch` to install its listeners and post the request.
    await new Promise((r) => setTimeout(r, 0));

    // Drive the response so the promise resolves and the test exits cleanly.
    for (const l of msgListeners) {
      l({
        type: 'response-head',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
      });
    }
    for (const l of msgListeners) {
      l({ type: 'response-chunk', dataBase64: btoa('refs response') });
    }
    for (const l of msgListeners) {
      l({ type: 'response-end' });
    }

    const resp = await requestPromise;

    // The SW Port — and only the SW Port — sees the request. The SW-side
    // `extractAndUnmaskUrlCredentials` path is the one that runs.
    expect(connect).toHaveBeenCalledWith({ name: 'fetch-proxy.fetch' });
    expect(postedMessages).toHaveLength(1);
    const request = postedMessages[0] as { type: string; url: string };
    expect(request.type).toBe('request');
    expect(request.url).toBe(CLONE_URL);
    expect(request.url).toContain(`x-access-token:${MASKED}@`);

    expect(resp.statusCode).toBe(200);
  });
});
