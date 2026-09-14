import type { GitHttpRequest } from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MASKED = 'MASK_abc123def456abc123def456';
const CLONE_URL = `https://x-access-token:${MASKED}@github.com/owner/repo.git/info/refs?service=git-upload-pack`;

describe('git-http — token-in-URL clone reaches the fetch-proxy unmask path', () => {
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;

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
    (globalThis as { chrome?: unknown }).chrome = undefined;

    const { setChromeExtensionRealm } = await import('../../src/base/api-endpoint.js');
    setChromeExtensionRealm(false);

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

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [proxyUrl, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(proxyUrl).toBe('/api/fetch-proxy');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Target-URL']).toBe(CLONE_URL);
    expect(headers['X-Target-URL']).toContain(`x-access-token:${MASKED}@`);
    expect(headers['X-Target-URL']).toMatch(/^https:\/\/x-access-token:/);

    expect(resp.statusCode).toBe(200);
  });

  it('Extension mode: masked-cred URL is posted to the fetch-proxy.fetch Port', async () => {
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

    const { setChromeExtensionRealm } = await import('../../src/base/api-endpoint.js');
    setChromeExtensionRealm(true);

    const { createGitHttpClient } = await import('../../src/git/git-http.js');
    const client = createGitHttpClient();
    const req: GitHttpRequest = {
      url: CLONE_URL,
      method: 'GET',
      headers: { 'user-agent': 'git/isomorphic-git' },
    };

    const requestPromise = client.request(req);

    await new Promise((r) => setTimeout(r, 0));

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

    expect(connect).toHaveBeenCalledWith({ name: 'fetch-proxy.fetch' });
    expect(postedMessages).toHaveLength(1);
    const request = postedMessages[0] as { type: string; url: string };
    expect(request.type).toBe('request');
    expect(request.url).toBe(CLONE_URL);
    expect(request.url).toContain(`x-access-token:${MASKED}@`);

    expect(resp.statusCode).toBe(200);
  });
});
