/**
 * Tests for the LLM-proxy SW's thin-bridge config resolver.
 *
 * Pins the two-tier lookup contract: the `postMessage` cache wins when
 * present, and a cache miss falls back to parsing `bridge`/`bridgeToken`
 * from the controlling client's URL via the shared
 * `bridge-launch-params` constants. Without the fallback the SW would
 * lose thin-bridge mode on every eviction/restart and Bedrock + Adobe
 * requests would fail with the Cloudflare "Fetch proxy not available in
 * worker mode" 404 again.
 */

import { describe, expect, it } from 'vitest';
import {
  isBridgeConfigMessage,
  resolveBridgeConfig,
  resolveFetchProxyTarget,
  SW_BRIDGE_CONFIG_MESSAGE,
} from '../../src/ui/llm-proxy-sw-config.js';

describe('resolveBridgeConfig', () => {
  it('returns null when there is no cache and no client URL', () => {
    expect(resolveBridgeConfig(null, null)).toBeNull();
    expect(resolveBridgeConfig({ apiBaseUrl: null, token: null }, null)).toBeNull();
  });

  it('prefers the cached values over the client URL', () => {
    const cached = { apiBaseUrl: 'http://localhost:5710', token: 'cached-token' };
    const clientUrl = 'https://www.sliccy.ai/?bridge=ws://localhost:9999/cdp&bridgeToken=url-token';
    const out = resolveBridgeConfig(cached, clientUrl);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'cached-token' });
  });

  it('strips a trailing slash from the cached apiBaseUrl', () => {
    const out = resolveBridgeConfig({ apiBaseUrl: 'http://localhost:5710/', token: 't' }, null);
    expect(out?.apiBaseUrl).toBe('http://localhost:5710');
  });

  it('falls back to parsing the controlling client URL when cache is empty', () => {
    const clientUrl =
      'https://www.sliccy.ai/?bridge=ws%3A%2F%2Flocalhost%3A5710%2Fcdp&bridgeToken=abc-123';
    const out = resolveBridgeConfig(null, clientUrl);
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5710', token: 'abc-123' });
  });

  it('treats a partial cache (apiBaseUrl only) as a miss and falls back', () => {
    const out = resolveBridgeConfig(
      { apiBaseUrl: 'http://localhost:5710', token: null },
      'https://www.sliccy.ai/?bridge=ws://localhost:5711/cdp&bridgeToken=fallback-token'
    );
    expect(out).toEqual({ apiBaseUrl: 'http://localhost:5711', token: 'fallback-token' });
  });

  it('returns null when the client URL is unparseable', () => {
    expect(resolveBridgeConfig(null, 'not a url')).toBeNull();
  });

  it('returns null when the client URL lacks both bridge params', () => {
    expect(resolveBridgeConfig(null, 'https://www.sliccy.ai/?foo=bar')).toBeNull();
  });

  it('returns null when only one of the two params is present', () => {
    expect(
      resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridge=ws://localhost:5710/cdp')
    ).toBeNull();
    expect(resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridgeToken=abc')).toBeNull();
  });

  it('returns null when the bridge URL cannot derive an api base', () => {
    // Bare hostname → URL parser fails → deriveBridgeApiBaseUrl → null.
    expect(
      resolveBridgeConfig(null, 'https://www.sliccy.ai/?bridge=not-a-url&bridgeToken=t')
    ).toBeNull();
  });
});

describe('resolveFetchProxyTarget', () => {
  it('returns the same-origin path when no bridge config is in effect', () => {
    expect(resolveFetchProxyTarget('/api/fetch-proxy', null)).toBe('/api/fetch-proxy');
  });

  it('prepends the local node-server origin in thin-bridge mode', () => {
    expect(
      resolveFetchProxyTarget('/api/fetch-proxy', {
        apiBaseUrl: 'http://localhost:5710',
        token: 'abc',
      })
    ).toBe('http://localhost:5710/api/fetch-proxy');
  });
});

describe('isBridgeConfigMessage', () => {
  it('accepts the tagged message shape', () => {
    expect(
      isBridgeConfigMessage({
        type: SW_BRIDGE_CONFIG_MESSAGE,
        apiBaseUrl: 'http://localhost:5710',
        token: 'abc',
      })
    ).toBe(true);
  });

  it('rejects unrelated messages', () => {
    expect(isBridgeConfigMessage(null)).toBe(false);
    expect(isBridgeConfigMessage(undefined)).toBe(false);
    expect(isBridgeConfigMessage('string')).toBe(false);
    expect(isBridgeConfigMessage({ type: 'something-else' })).toBe(false);
    expect(isBridgeConfigMessage({})).toBe(false);
  });
});
