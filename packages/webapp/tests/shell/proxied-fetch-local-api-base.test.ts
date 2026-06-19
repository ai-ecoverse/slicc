/**
 * Thin-bridge `setLocalApiBaseUrl` behavior in `createProxiedFetch`'s CLI
 * branch. When the hosted leader (sliccy.ai) serves the UI but has no
 * local /api surface, the bridge-launch wiring sets a per-realm absolute
 * origin so proxied fetches reach the local node-server cross-origin.
 *
 * The setter is per-realm: the page realm and the kernel-worker realm
 * each call it once during boot. Tests reset to `null` between cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createProxiedFetch — local API base (thin-bridge)', () => {
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;
    (globalThis as { chrome?: unknown }).chrome = undefined;
    mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('{}', {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    });
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      mockFetch as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    if (originalFetch) {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
    // Reset module-level base + token so cases don't leak.
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    vi.restoreAllMocks();
  });

  it('defaults to same-origin /api/fetch-proxy when no base is set', async () => {
    const { createProxiedFetch, getLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    expect(getLocalApiBaseUrl()).toBeNull();
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('/api/fetch-proxy');
  });

  it('prepends the configured local API base to /api/fetch-proxy', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl, getLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710');
    expect(getLocalApiBaseUrl()).toBe('http://localhost:5710');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5710/api/fetch-proxy');
  });

  it('strips trailing slashes from the base so the path is not double-slashed', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710///');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:5710/api/fetch-proxy');
  });

  it('treats null and empty string as a reset to same-origin', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl, getLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710');
    setLocalApiBaseUrl('');
    expect(getLocalApiBaseUrl()).toBeNull();
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/fetch-proxy');

    setLocalApiBaseUrl('http://localhost:5710');
    setLocalApiBaseUrl(null);
    expect(getLocalApiBaseUrl()).toBeNull();
  });

  it('preserves the X-Target-URL header alongside the rewritten endpoint', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'POST', body: '{}' });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Target-URL']).toBe('https://api.example.com/v1');
  });

  it('attaches X-Bridge-Token when a token is set alongside a local API base', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl, setBridgeToken, getBridgeToken } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    expect(getBridgeToken()).toBe('abc-123');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBe('abc-123');
  });

  it('omits X-Bridge-Token on the same-origin path even when a token is set', async () => {
    // No local API base set → same-origin /api/fetch-proxy. The token
    // requirement only applies to cross-origin calls; sending it on
    // same-origin would leak a session capability the local UI doesn't
    // need.
    const { createProxiedFetch, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setBridgeToken('abc-123');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/fetch-proxy');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });

  it('omits X-Bridge-Token when only the API base is set (no token configured)', async () => {
    const { createProxiedFetch, setLocalApiBaseUrl } = await import(
      '../../src/shell/proxied-fetch.js'
    );
    setLocalApiBaseUrl('http://localhost:5710');
    await createProxiedFetch()('https://api.example.com/v1', { method: 'GET' });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Bridge-Token']).toBeUndefined();
  });

  it('treats null and empty string as a reset for the bridge token', async () => {
    const { setBridgeToken, getBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setBridgeToken('abc-123');
    expect(getBridgeToken()).toBe('abc-123');
    setBridgeToken('');
    expect(getBridgeToken()).toBeNull();
    setBridgeToken('abc-123');
    setBridgeToken(null);
    expect(getBridgeToken()).toBeNull();
  });
});
