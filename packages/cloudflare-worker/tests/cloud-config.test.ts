import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCloudConfig } from '../src/cloud/handler-config.js';
import { clearProxyConfigCache } from '../src/cloud/proxy-config.js';

afterEach(() => {
  clearProxyConfigCache();
  vi.restoreAllMocks();
});

describe('GET /api/cloud/config', () => {
  it('returns proxy-derived clientId + scopes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({
            clientId: 'experience-catalyst-prod',
            scopes: 'openid,AdobeID',
            imsEnvironment: 'prod',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.imsClientId).toBe('experience-catalyst-prod');
    expect(body.imsScope).toBe('openid,AdobeID');
    expect(body.imsAuthorizeUrl).toBe('https://ims-na1.adobelogin.com/ims/authorize/v2');
    expect(body.imsRelayUrl).toBe('https://www.sliccy.ai/auth/callback');
  });

  it('passes the proxy model list through as adobeModels', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({
            clientId: 'x',
            scopes: 'y',
            imsEnvironment: 'prod',
            models: [
              { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
              { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    const body = (await res.json()) as { adobeModels: Array<{ id: string; name: string }> };
    // Only id + name pass through (extra proxy fields are dropped).
    expect(body.adobeModels).toEqual([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    ]);
  });

  it('returns adobeModels: [] when the proxy omits models', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'prod' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    const body = (await res.json()) as { adobeModels: unknown[] };
    expect(body.adobeModels).toEqual([]);
  });

  it('returns 502 PROXY_CONFIG_UNAVAILABLE when proxy is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PROXY_CONFIG_UNAVAILABLE');
  });

  it('returns 500 PROXY_CONFIG_INVALID when proxy returns malformed config', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        // Return 200 but missing required fields
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('PROXY_CONFIG_INVALID');
  });

  it('honors ADOBE_PROXY_ENDPOINT override', async () => {
    let calledUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      calledUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'stg1' }), {
        status: 200,
      });
    });
    await handleCloudConfig(new Request('https://w/api/cloud/config'), {
      ADOBE_PROXY_ENDPOINT: 'https://staging-proxy.example',
    });
    expect(calledUrl).toBe('https://staging-proxy.example/v1/config');
  });

  it('caches proxy config for 5 minutes', async () => {
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        callCount++;
        return new Response(
          JSON.stringify({ clientId: 'cached', scopes: 'cached', imsEnvironment: 'prod' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    // First call
    await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    expect(callCount).toBe(1);
    // Second call should use cache
    await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    expect(callCount).toBe(1);
  });

  it('uses IMS_RELAY_URL env var when provided', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'prod' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {
      IMS_RELAY_URL: 'https://staging.example/auth/callback',
    });
    const body = (await res.json()) as Record<string, string>;
    expect(body.imsRelayUrl).toBe('https://staging.example/auth/callback');
  });

  it('defaults to production relay URL when IMS_RELAY_URL not set', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'prod' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    const body = (await res.json()) as Record<string, string>;
    expect(body.imsRelayUrl).toBe('https://www.sliccy.ai/auth/callback');
  });

  it('omits retired cone cap fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'prod' }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('capRunning');
    expect(body).not.toHaveProperty('capPaused');
  });
});
