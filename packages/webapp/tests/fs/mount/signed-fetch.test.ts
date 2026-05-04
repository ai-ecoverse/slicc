/**
 * Direct tests for the browser-side transport layer in
 * `packages/webapp/src/fs/mount/signed-fetch.ts`.
 *
 * The transport functions live between the backend (which builds logical
 * requests) and the wire (HTTP POST in CLI / chrome.runtime.sendMessage in
 * extension). They:
 *   - serialize envelopes
 *   - parse server replies
 *   - map errorCode strings to FsError codes
 *   - convert success replies to Response objects via base64 decode
 *
 * Bugs here surface as opaque DOMException / SyntaxError crashes inside
 * the agent's tool execution — exactly the kind of "production-only"
 * failure the indirect backend tests miss.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSignedFetchS3 } from '../../../src/fs/mount/signed-fetch.js';
import type { SignAndForwardReply } from '../../../src/fs/mount/sign-and-forward-shared.js';

// ----------------- helpers -----------------

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
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

// ----------------- envelopeToResponse via the public transport -----------------

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

  it('handles empty bodyBase64 as zero-byte response', async () => {
    // Using 200 instead of 204 because the WHATWG Response constructor
    // rejects status codes that forbid a body (204/205/304) when given
    // any body argument — even an empty Uint8Array. The transport always
    // constructs Response with a Uint8Array, so empty-body upstream
    // responses round-trip as 200 + empty body in this layer.
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
        // Cast to bypass the literal-union — simulating a future server adding
        // a new code the browser doesn't know about.
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
      message: expect.stringContaining('not a JSON envelope'),
    });
  });

  it('malformed bodyBase64 in successful envelope → EIO with decode-failed hint', async () => {
    mockFetch(async () =>
      jsonResponse({
        ok: true,
        status: 200,
        headers: {},
        // Invalid base64 (contains characters outside the alphabet that atob
        // is strict about). `!@#` is rejected by all browsers.
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
    // Body is base64-encoded in the envelope.
    const decoded = atob(parsed.bodyBase64);
    expect(decoded).toBe('hello world');
  });
});
