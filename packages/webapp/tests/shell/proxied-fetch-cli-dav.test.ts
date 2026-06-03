/**
 * CLI branch of `createProxiedFetch` must forward arbitrary WebDAV/CalDAV
 * verbs (PROPFIND, REPORT, MKCALENDAR, LOCK) verbatim into the outer
 * `fetch('/api/fetch-proxy', init)` call along with any caller-supplied
 * body. Regression guard for the verb plumbing — if an intermediate adapter
 * tightens the method allowlist, these tests fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAV_VERBS = ['PROPFIND', 'REPORT', 'MKCALENDAR', 'LOCK'] as const;

describe('createProxiedFetch — CLI branch DAV verb pass-through', () => {
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;
    // CLI mode — no chrome runtime.
    (globalThis as { chrome?: unknown }).chrome = undefined;
    mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('<multistatus/>', {
        status: 207,
        statusText: 'Multi-Status',
        headers: { 'content-type': 'application/xml' },
      });
    });
    (globalThis as { fetch: typeof globalThis.fetch }).fetch =
      mockFetch as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    if (originalFetch) {
      (globalThis as { fetch: typeof globalThis.fetch }).fetch = originalFetch;
    }
    vi.restoreAllMocks();
  });

  for (const verb of DAV_VERBS) {
    it(`forwards ${verb} as the outer init.method`, async () => {
      const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
      const proxiedFetch = createProxiedFetch();

      await proxiedFetch('https://caldav.example.com/cal/', {
        method: verb,
        headers: { 'Content-Type': 'application/xml', Depth: '1' },
        body: '<propfind xmlns="DAV:"><prop><displayname/></prop></propfind>',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/fetch-proxy');
      expect((init as RequestInit).method).toBe(verb);
    });

    it(`forwards ${verb} body verbatim into init.body`, async () => {
      const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
      const proxiedFetch = createProxiedFetch();

      const body = `<request verb="${verb}"/>`;
      await proxiedFetch('https://caldav.example.com/cal/', {
        method: verb,
        headers: { 'Content-Type': 'application/xml' },
        body,
      });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      // Text content-type → body is forwarded as the same string the
      // caller passed in (prepareRequestBody returns it unchanged).
      expect(init.body).toBe(body);
    });

    it(`encodes forbidden request headers (Cookie/Origin/Referer) for ${verb}`, async () => {
      const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
      const proxiedFetch = createProxiedFetch();

      await proxiedFetch('https://caldav.example.com/cal/', {
        method: verb,
        headers: {
          Cookie: 'sid=abc',
          Origin: 'https://caldav.example.com',
          Referer: 'https://caldav.example.com/principals/',
          Depth: '1',
        },
        body: '<x/>',
      });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Proxy-Cookie']).toBe('sid=abc');
      expect(headers['X-Proxy-Origin']).toBe('https://caldav.example.com');
      expect(headers['X-Proxy-Referer']).toBe('https://caldav.example.com/principals/');
      // Non-forbidden DAV headers pass through unchanged.
      expect(headers['Depth']).toBe('1');
      // Target URL header always present.
      expect(headers['X-Target-URL']).toBe('https://caldav.example.com/cal/');
    });
  }

  it('omits body for GET (sanity check that the DAV-body guard is method-aware)', async () => {
    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    await proxiedFetch('https://caldav.example.com/cal/', {
      method: 'GET',
      body: 'should-not-be-sent',
    });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});
