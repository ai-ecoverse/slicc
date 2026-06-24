/**
 * `resolveApiUrl(path)` + `apiHeaders(extra?)` — the shared helper pair
 * Wave 7b callers use so every `/api/*` site honors the same thin-bridge
 * base + bridge-token rules without hand-rolling relative strings.
 *
 * The setters are per-realm (page realm in `setupStandalonePrelude`,
 * kernel-worker realm in `kernel-worker`); each test resets module state
 * in `afterEach` so cases don't leak.
 */

import { afterEach, describe, expect, it } from 'vitest';

describe('proxied-fetch — resolveApiUrl + apiHeaders', () => {
  afterEach(async () => {
    const { setLocalApiBaseUrl, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
  });

  describe('resolveApiUrl', () => {
    it('returns the path unchanged when no local API base is set (same-origin)', async () => {
      const { resolveApiUrl } = await import('../../src/shell/proxied-fetch.js');
      expect(resolveApiUrl('/api/secrets')).toBe('/api/secrets');
      expect(resolveApiUrl('/api/fetch-proxy')).toBe('/api/fetch-proxy');
      expect(resolveApiUrl('/api/webhooks/abc')).toBe('/api/webhooks/abc');
    });

    it('prepends the configured base when set (thin-bridge)', async () => {
      const { resolveApiUrl, setLocalApiBaseUrl } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      expect(resolveApiUrl('/api/secrets')).toBe('http://localhost:5710/api/secrets');
      expect(resolveApiUrl('/api/fetch-proxy')).toBe('http://localhost:5710/api/fetch-proxy');
    });

    it('does not double-slash when the base setter trims trailing slashes', async () => {
      const { resolveApiUrl, setLocalApiBaseUrl } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710///');
      expect(resolveApiUrl('/api/secrets')).toBe('http://localhost:5710/api/secrets');
    });

    it('reverts to same-origin after the base is cleared', async () => {
      const { resolveApiUrl, setLocalApiBaseUrl } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      setLocalApiBaseUrl(null);
      expect(resolveApiUrl('/api/secrets')).toBe('/api/secrets');
    });
  });

  describe('apiHeaders', () => {
    it('returns an empty record when no token / no base is configured', async () => {
      const { apiHeaders } = await import('../../src/shell/proxied-fetch.js');
      expect(apiHeaders()).toEqual({});
    });

    it('attaches X-Bridge-Token when both base + token are set (thin-bridge)', async () => {
      const { apiHeaders, setLocalApiBaseUrl, setBridgeToken } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      setBridgeToken('abc-123');
      expect(apiHeaders()).toEqual({ 'X-Bridge-Token': 'abc-123' });
    });

    it('omits X-Bridge-Token on same-origin even when a token is set', async () => {
      // Symmetry guarantee with the createProxiedFetch CLI branch — the
      // local node-server doesn't require the token for loopback origins
      // and sending it on same-origin would leak a session capability.
      const { apiHeaders, setBridgeToken } = await import('../../src/shell/proxied-fetch.js');
      setBridgeToken('abc-123');
      expect(apiHeaders()).toEqual({});
    });

    it('omits X-Bridge-Token when only the base is set (no token configured)', async () => {
      const { apiHeaders, setLocalApiBaseUrl } = await import('../../src/shell/proxied-fetch.js');
      setLocalApiBaseUrl('http://localhost:5710');
      expect(apiHeaders()).toEqual({});
    });

    it('layers `extra` overrides on top of the bridge token', async () => {
      const { apiHeaders, setLocalApiBaseUrl, setBridgeToken } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      setBridgeToken('abc-123');
      expect(
        apiHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' })
      ).toEqual({
        'X-Bridge-Token': 'abc-123',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      });
    });

    it('lets an explicit `extra` override clobber X-Bridge-Token', async () => {
      const { apiHeaders, setLocalApiBaseUrl, setBridgeToken } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      setBridgeToken('abc-123');
      expect(apiHeaders({ 'X-Bridge-Token': 'forced-override' })).toEqual({
        'X-Bridge-Token': 'forced-override',
      });
    });
  });

  describe('worker-realm boot forwarding', () => {
    it('reflects the values the kernel-worker init step forwards via setters', async () => {
      // The kernel-worker realm has its own module instance and boots by
      // calling `setLocalApiBaseUrl(init.localApiBaseUrl ?? null)` +
      // `setBridgeToken(init.bridgeToken ?? null)` (see kernel-worker.ts).
      // The page realm does the same in setupStandalonePrelude. This
      // test exercises the identical entrypoint to prove the helpers
      // pick up bridge values without any extra plumbing.
      const { resolveApiUrl, apiHeaders, setLocalApiBaseUrl, setBridgeToken } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      setLocalApiBaseUrl('http://localhost:5710');
      setBridgeToken('worker-token');

      expect(resolveApiUrl('/api/secrets')).toBe('http://localhost:5710/api/secrets');
      expect(apiHeaders({ Accept: 'application/json' })).toEqual({
        'X-Bridge-Token': 'worker-token',
        Accept: 'application/json',
      });
    });

    it('matches the worker-init no-bridge case (init.localApiBaseUrl / bridgeToken absent)', async () => {
      const { resolveApiUrl, apiHeaders, setLocalApiBaseUrl, setBridgeToken } = await import(
        '../../src/shell/proxied-fetch.js'
      );
      // `init.localApiBaseUrl ?? null` / `init.bridgeToken ?? null` when
      // the leader runs same-origin — the bundled-UI legacy path.
      setLocalApiBaseUrl(null);
      setBridgeToken(null);

      expect(resolveApiUrl('/api/secrets')).toBe('/api/secrets');
      expect(apiHeaders()).toEqual({});
    });
  });
});
