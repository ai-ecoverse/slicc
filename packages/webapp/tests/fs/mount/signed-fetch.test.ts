import type { SignAndForwardReply } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMountCapabilityBroker } from '../../../src/fs/mount/capability-broker.js';
import { makeSignedFetchDa, makeSignedFetchS3 } from '../../../src/fs/mount/signed-fetch.js';
import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import { createRestCapabilityBroker } from '../../../src/work-unit/capability/index.js';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  setMountCapabilityBroker(createRestCapabilityBroker());
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  setMountCapabilityBroker(undefined);

  setLocalApiBaseUrl(null);
  setBridgeToken(null);
  vi.restoreAllMocks();
});

function jsonResponse(body: SignAndForwardReply, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

function mockFetch(impl: (url?: unknown, init?: { body?: unknown }) => Promise<Response>): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

describe('signed-fetch CLI transport — success path', () => {
  it('round-trips bodyBase64 into a Response with status, headers, and body', async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        status: 200,
        headers: { etag: '"e1"', 'content-type': 'application/octet-stream' },
        bodyBase64: b64(new TextEncoder().encode('hello')),
      })
    );
    const transport = makeSignedFetchS3('aws');
    const res = await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"e1"');
    expect(await res.text()).toBe('hello');
  });

  it('handles empty bodyBase64 as zero-byte response (200)', async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        status: 200,
        headers: {},
        bodyBase64: '',
      })
    );
    const transport = makeSignedFetchS3('aws');
    const res = await transport({ method: 'DELETE', bucket: 'b', key: 'k' });
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  it('passes null body to Response for null-body statuses (204 DELETE)', async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        status: 204,
        headers: {},
        bodyBase64: '',
      })
    );
    const transport = makeSignedFetchS3('aws');
    const res = await transport({ method: 'DELETE', bucket: 'b', key: 'k' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('passes null body for 205 (Reset Content) and 304 (Not Modified)', async () => {
    mockFetch(async () => jsonResponse({ ok: true, status: 205, headers: {}, bodyBase64: '' }));
    let transport = makeSignedFetchS3('aws');
    let res = await transport({ method: 'POST', bucket: 'b', key: 'k' });
    expect(res.status).toBe(205);
    expect(res.body).toBeNull();

    mockFetch(async () => jsonResponse({ ok: true, status: 304, headers: {}, bodyBase64: '' }));
    transport = makeSignedFetchS3('aws');
    res = await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });
});

describe('signed-fetch CLI transport — envelope error mapping', () => {
  it('profile_not_configured → EACCES', async () => {
    mockFetch(async () =>
      jsonResponse(
        {
          ok: false,
          error: "profile 'aws' missing required field 'access_key_id'",
          errorCode: 'profile_not_configured',
        },
        400
      )
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EACCES',
      message: expect.stringContaining('access_key_id'),
    });
  });

  it('invalid_profile → EACCES', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: false, error: 'invalid profile name', errorCode: 'invalid_profile' }, 400)
    );
    const transport = makeSignedFetchS3('a/b');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('invalid_request → EINVAL', async () => {
    mockFetch(async () =>
      jsonResponse({ ok: false, error: 'invalid bucket', errorCode: 'invalid_request' }, 400)
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: '', key: 'k' })).rejects.toMatchObject({
      code: 'EINVAL',
    });
  });

  it('fetch_failed → EIO', async () => {
    mockFetch(async () =>
      jsonResponse(
        { ok: false, error: 'S3 fetch failed: network down', errorCode: 'fetch_failed' },
        502
      )
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('network down'),
    });
  });

  it('internal → EIO', async () => {
    mockFetch(async () =>
      jsonResponse(
        { ok: false, error: 'internal sign-and-forward error', errorCode: 'internal' },
        500
      )
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
    });
  });

  it('unknown errorCode surfaces as EINVAL with the raw code in message', async () => {
    mockFetch(async () =>
      jsonResponse(
        {
          ok: false,
          error: 'rate limited',
          errorCode: 'rate_limited' as 'fetch_failed',
        },
        429
      )
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EINVAL',
      message: expect.stringContaining('rate_limited'),
    });
  });
});

describe('signed-fetch CLI transport — wire failures', () => {
  it('fetch() rejects → EIO with localhost-backend hint', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('SLICC backend at localhost'),
    });
  });

  it('non-JSON 502 (Express HTML error page) → EIO with parse-error hint', async () => {
    mockFetch(async () => htmlResponse('<html><body>Internal Server Error</body></html>', 502));
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('not an envelope'),
    });
  });

  it('malformed bodyBase64 in successful envelope → EIO with decode-failed hint', async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        status: 200,
        headers: {},

        bodyBase64: '!@#$%^&*()',
      })
    );
    const transport = makeSignedFetchS3('aws');
    await expect(transport({ method: 'GET', bucket: 'b', key: 'k' })).rejects.toMatchObject({
      code: 'EIO',
      message: expect.stringContaining('decode failed'),
    });
  });
});

describe('signed-fetch CLI transport — request envelope shape', () => {
  it('POSTs to /api/s3-sign-and-forward with the profile name and request fields', async () => {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;
    mockFetch(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = (init?.body ?? null) as string | null;
      return jsonResponse({
        ok: true,
        status: 200,
        headers: {},
        bodyBase64: '',
      });
    });
    const transport = makeSignedFetchS3('r2');
    await transport({
      method: 'PUT',
      bucket: 'my-bucket',
      key: 'foo/bar.txt',
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode('hello world'),
    });

    expect(capturedUrl).toBe('/api/s3-sign-and-forward');
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.profile).toBe('r2');
    expect(parsed.method).toBe('PUT');
    expect(parsed.bucket).toBe('my-bucket');
    expect(parsed.key).toBe('foo/bar.txt');
    expect(parsed.headers).toEqual({ 'content-type': 'text/plain' });

    const decoded = atob(parsed.bodyBase64);
    expect(decoded).toBe('hello world');
  });
});

describe('signed-fetch CLI transport — thin-bridge URL + token', () => {
  function captureCall(): {
    getUrl: () => string | null;
    getHeaders: () => Record<string, string> | null;
  } {
    let capturedUrl: string | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    mockFetch(async (url, init) => {
      capturedUrl = String(url);
      const initObj = init as { headers?: Record<string, string> } | undefined;
      capturedHeaders = (initObj?.headers ?? null) as Record<string, string> | null;
      return jsonResponse({ ok: true, status: 200, headers: {}, bodyBase64: '' });
    });
    return { getUrl: () => capturedUrl, getHeaders: () => capturedHeaders };
  }

  it('legacy / same-origin: relative /api/s3-sign-and-forward, no X-Bridge-Token', async () => {
    const cap = captureCall();
    const transport = makeSignedFetchS3('aws');
    await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(cap.getUrl()).toBe('/api/s3-sign-and-forward');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();

    expect(headers!['Content-Type']).toBe('application/json');
  });

  it('thin-bridge: S3 envelope POSTs to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const cap = captureCall();
    const transport = makeSignedFetchS3('aws');
    await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(cap.getUrl()).toBe('http://localhost:5710/api/s3-sign-and-forward');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBe('abc-123');
    expect(headers!['Content-Type']).toBe('application/json');
  });

  it('thin-bridge: DA envelope POSTs to the bridge origin with X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('abc-123');
    const cap = captureCall();
    const transport = makeSignedFetchDa({ getImsToken: async () => 'ims-token' });
    await transport({ method: 'GET', path: '/source/foo' });
    expect(cap.getUrl()).toBe('http://localhost:5710/api/da-sign-and-forward');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBe('abc-123');
  });

  it('thin-bridge: base set but no token → absolute URL, still no X-Bridge-Token', async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    const cap = captureCall();
    const transport = makeSignedFetchS3('aws');
    await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(cap.getUrl()).toBe('http://localhost:5710/api/s3-sign-and-forward');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();
  });

  it('token set but no base → same-origin path, X-Bridge-Token omitted', async () => {
    setBridgeToken('abc-123');
    const cap = captureCall();
    const transport = makeSignedFetchS3('aws');
    await transport({ method: 'GET', bucket: 'b', key: 'k' });
    expect(cap.getUrl()).toBe('/api/s3-sign-and-forward');
    const headers = cap.getHeaders();
    expect(headers).not.toBeNull();
    expect(headers!['X-Bridge-Token']).toBeUndefined();
  });
});
