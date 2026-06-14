/**
 * `curl -X <DAV-VERB>` round-trip through `AlmostBashShell` → just-bash curl shim →
 * `SecureFetch` (our `createProxiedFetch()` CLI branch) → mocked
 * `globalThis.fetch('/api/fetch-proxy', init)`.
 *
 * Verifies the agent can issue WebDAV/CalDAV requests with arbitrary verbs
 * from the bash tool. If just-bash's curl shim drops `-X PROPFIND` (or the
 * supplied body) on the floor, the corresponding test fails — that finding
 * is then a spec-level follow-up (per task definition of done), not a fix
 * inside this package.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShell } from '../../src/shell/almost-bash-shell.js';

const DAV_VERBS = ['PROPFIND', 'REPORT', 'MKCALENDAR', 'LOCK'] as const;

let dbCounter = 0;

describe('AlmostBashShell curl shim — DAV verb pass-through', () => {
  let fs: VirtualFS;
  let originalChrome: unknown;
  let originalFetch: typeof globalThis.fetch | undefined;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-curl-dav-${dbCounter++}`, wipe: true });
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFetch = globalThis.fetch;
    // CLI mode — createProxiedFetch() routes through globalThis.fetch('/api/fetch-proxy', …).
    (globalThis as { chrome?: unknown }).chrome = undefined;
    mockFetch = vi.fn().mockImplementation(async () => {
      return new Response('<multistatus xmlns="DAV:"/>', {
        status: 207,
        statusText: 'Multi-Status',
        headers: { 'content-type': 'application/xml; charset=utf-8' },
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
    vi.restoreAllMocks();
    await fs.dispose();
  });

  for (const verb of DAV_VERBS) {
    it(`propagates curl -X ${verb} -d '<xml/>' through SecureFetch as method=${verb}`, async () => {
      const shell = new AlmostBashShell({ fs });
      const body = `<request verb="${verb}"/>`;

      const result = await shell.executeCommand(
        `curl -s -X ${verb} -H 'Content-Type: application/xml' -d '${body}' https://caldav.example.com/cal/`
      );

      if (mockFetch.mock.calls.length === 0) {
        // Treat as documented follow-up: just-bash's curl shim did NOT
        // reach `SecureFetch` at all (e.g. rejected the verb pre-fetch).
        // Surface enough context for the spec follow-up note rather than
        // a silent skip.
        throw new Error(
          `curl shim did not call SecureFetch for verb ${verb}; ` +
            `exit=${result.exitCode}, stderr=${JSON.stringify(result.stderr)}`
        );
      }
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/fetch-proxy');
      expect((init as RequestInit).method).toBe(verb);
      const fwdHeaders = (init as RequestInit).headers as Record<string, string>;
      expect(fwdHeaders['X-Target-URL']).toBe('https://caldav.example.com/cal/');

      // Body survives the curl-shim → SecureFetch → proxiedFetch hop.
      // prepareRequestBody passes text bodies through verbatim (string).
      expect(init.body).toBe(body);
    });
  }

  it('still allows GET as a baseline (sanity check the harness)', async () => {
    const shell = new AlmostBashShell({ fs });
    await shell.executeCommand('curl -s -X GET https://caldav.example.com/cal/');
    expect(mockFetch).toHaveBeenCalled();
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('GET');
  });
});
