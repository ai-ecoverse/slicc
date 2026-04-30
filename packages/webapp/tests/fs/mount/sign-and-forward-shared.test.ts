import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeDaSignAndForward,
  executeS3SignAndForward,
  type S3SignAndForwardEnvelope,
  type SecretGetter,
} from '../../../src/fs/mount/sign-and-forward-shared.js';

// ----------------- helpers -----------------

class InMemorySecretGetter implements SecretGetter {
  private map = new Map<string, string>();
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

function makeFetchMock(responses: MockResponse[]): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected fetch call to ${String(url)} (no queued response)`);
    }
    const headers = new Headers(next.headers ?? {});
    return new Response((next.body ?? new Uint8Array(0)) as RequestInit['body'], {
      status: next.status,
      headers,
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ----------------- S3 -----------------

describe('executeS3SignAndForward — validation', () => {
  let store: InMemorySecretGetter;
  beforeEach(() => {
    store = new InMemorySecretGetter();
  });

  it('rejects invalid profile name (regex)', async () => {
    const reply = await executeS3SignAndForward(
      { profile: 'aws/etc/passwd', method: 'GET', bucket: 'b', key: 'k' },
      store
    );
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.errorCode).toBe('invalid_profile');
  });

  it('rejects empty profile', async () => {
    const reply = await executeS3SignAndForward(
      { profile: '', method: 'GET', bucket: 'b', key: 'k' },
      store
    );
    expect(reply.ok === false && reply.errorCode).toBe('invalid_profile');
  });

  it('rejects unknown method', async () => {
    const reply = await executeS3SignAndForward(
      {
        profile: 'aws',
        method: 'PATCH',
        bucket: 'b',
        key: 'k',
      } as unknown as S3SignAndForwardEnvelope,
      store
    );
    expect(reply.ok === false && reply.errorCode).toBe('invalid_request');
  });

  it('rejects empty bucket', async () => {
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: '', key: 'k' },
      store
    );
    expect(reply.ok === false && reply.errorCode).toBe('invalid_request');
  });

  it('returns profile_not_configured with actionable message', async () => {
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
      store
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.errorCode).toBe('profile_not_configured');
      expect(reply.error).toContain("missing required field 'access_key_id'");
      expect(reply.error).toContain('secret set s3.aws.access_key_id');
    }
  });

  it('detects partial config (missing secret_access_key)', async () => {
    store.set('s3.aws.access_key_id', 'AKIA1');
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
      store
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.errorCode).toBe('profile_not_configured');
      expect(reply.error).toContain("missing required field 'secret_access_key'");
    }
  });
});

describe('executeS3SignAndForward — successful sign + forward', () => {
  let store: InMemorySecretGetter;
  beforeEach(() => {
    store = new InMemorySecretGetter();
    store.set('s3.aws.access_key_id', 'AKIDEXAMPLE');
    store.set('s3.aws.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
    store.set('s3.aws.region', 'us-east-1');
  });

  it('virtual-hosted: builds bucket-prefixed URL and signs', async () => {
    const { fetch, calls } = makeFetchMock([
      {
        status: 200,
        headers: { etag: '"e1"', 'content-type': 'text/plain' },
        body: new TextEncoder().encode('hello'),
      },
    ]);
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: 'my-bucket', key: 'foo/bar.txt' },
      store,
      fetch
    );

    expect(reply.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/foo/bar.txt');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers['x-amz-content-sha256']).toBeDefined();
    expect(headers['x-amz-date']).toBeDefined();

    if (reply.ok) {
      expect(reply.status).toBe(200);
      expect(reply.headers.etag).toBe('"e1"');
      // Decode bodyBase64 — works in browser test env.
      const decoded = atob(reply.bodyBase64);
      expect(decoded).toBe('hello');
    }
  });

  it('honors --path-style: bucket lives in the path', async () => {
    store.set('s3.r2.access_key_id', 'AKIDEXAMPLE');
    store.set('s3.r2.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
    store.set('s3.r2.endpoint', 'https://account.r2.cloudflarestorage.com');
    store.set('s3.r2.path_style', 'true');

    const { fetch, calls } = makeFetchMock([{ status: 200, body: new Uint8Array() }]);
    const reply = await executeS3SignAndForward(
      { profile: 'r2', method: 'GET', bucket: 'my-bucket', key: 'foo.txt' },
      store,
      fetch
    );

    expect(reply.ok).toBe(true);
    expect(calls[0].url).toBe('https://account.r2.cloudflarestorage.com/my-bucket/foo.txt');
  });

  it('honors custom endpoint without --path-style: virtual-hosted on custom host', async () => {
    store.set('s3.r2.access_key_id', 'AKIDEXAMPLE');
    store.set('s3.r2.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
    store.set('s3.r2.endpoint', 'https://account.r2.cloudflarestorage.com');

    const { fetch, calls } = makeFetchMock([{ status: 200, body: new Uint8Array() }]);
    await executeS3SignAndForward(
      { profile: 'r2', method: 'GET', bucket: 'my-bucket', key: 'foo.txt' },
      store,
      fetch
    );

    expect(calls[0].url).toBe('https://my-bucket.account.r2.cloudflarestorage.com/foo.txt');
  });

  it('round-trips a body via base64 (PUT with content)', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, headers: { etag: '"e2"' } }]);
    const payload = new TextEncoder().encode('hello world');
    let binary = '';
    for (let i = 0; i < payload.length; i++) binary += String.fromCharCode(payload[i]);
    const bodyBase64 = btoa(binary);

    await executeS3SignAndForward(
      {
        profile: 'aws',
        method: 'PUT',
        bucket: 'my-bucket',
        key: 'foo.txt',
        bodyBase64,
      },
      store,
      fetch
    );

    const sentBody = calls[0].init?.body;
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sentBody as Uint8Array)).toBe('hello world');
  });

  it('passes query params into the URL', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: new Uint8Array() }]);
    await executeS3SignAndForward(
      {
        profile: 'aws',
        method: 'GET',
        bucket: 'my-bucket',
        key: '',
        query: { 'list-type': '2', prefix: 'foo/' },
      },
      store,
      fetch
    );

    expect(calls[0].url).toBe(
      'https://my-bucket.s3.us-east-1.amazonaws.com/?list-type=2&prefix=foo%2F'
    );
  });

  it('strips hop-by-hop headers from the reply', async () => {
    const { fetch } = makeFetchMock([
      {
        status: 200,
        headers: {
          etag: '"e3"',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array([1, 2, 3]),
      },
    ]);
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
      store,
      fetch
    );

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.headers.etag).toBe('"e3"');
      expect(reply.headers['content-type']).toBe('application/octet-stream');
      expect(reply.headers.connection).toBeUndefined();
      expect(reply.headers['transfer-encoding']).toBeUndefined();
    }
  });

  it('returns fetch_failed on network error', async () => {
    const erroring = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const reply = await executeS3SignAndForward(
      { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
      store,
      erroring
    );
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.errorCode).toBe('fetch_failed');
  });
});

// ----------------- DA -----------------

describe('executeDaSignAndForward', () => {
  it('rejects missing imsToken', async () => {
    const reply = await executeDaSignAndForward({ method: 'GET', path: '/source/o/r/k' });
    expect(reply.ok === false && reply.errorCode).toBe('invalid_request');
  });

  it('rejects path without leading slash', async () => {
    const reply = await executeDaSignAndForward({
      imsToken: 'tok',
      method: 'GET',
      path: 'source/o/r/k',
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain('starting with /');
  });

  it('attaches Bearer token and forwards to admin.da.live', async () => {
    const { fetch, calls } = makeFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"hello":"da"}'),
      },
    ]);
    const reply = await executeDaSignAndForward(
      {
        imsToken: 'ims-token-here',
        method: 'GET',
        path: '/source/my-org/my-repo/foo.html',
      },
      fetch
    );

    expect(reply.ok).toBe(true);
    expect(calls[0].url).toBe('https://admin.da.live/source/my-org/my-repo/foo.html');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ims-token-here');

    if (reply.ok) {
      expect(atob(reply.bodyBase64)).toBe('{"hello":"da"}');
    }
  });

  it('appends query params to the URL', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 200, body: new Uint8Array() }]);
    await executeDaSignAndForward(
      {
        imsToken: 'tok',
        method: 'GET',
        path: '/list/my-org/my-repo',
        query: { recursive: 'true' },
      },
      fetch
    );
    expect(calls[0].url).toBe('https://admin.da.live/list/my-org/my-repo?recursive=true');
  });

  it('round-trips a body via base64 (PUT with content)', async () => {
    const { fetch, calls } = makeFetchMock([{ status: 201, headers: { etag: '"e1"' } }]);
    const html = '<html></html>';
    const bytes = new TextEncoder().encode(html);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const bodyBase64 = btoa(binary);

    const reply = await executeDaSignAndForward(
      {
        imsToken: 'tok',
        method: 'PUT',
        path: '/source/o/r/foo.html',
        bodyBase64,
      },
      fetch
    );

    expect(reply.ok).toBe(true);
    const sentBody = calls[0].init?.body;
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sentBody as Uint8Array)).toBe(html);
  });

  it('returns fetch_failed on network error', async () => {
    const erroring = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const reply = await executeDaSignAndForward(
      { imsToken: 'tok', method: 'GET', path: '/source/o/r/k' },
      erroring
    );
    expect(reply.ok === false && reply.errorCode).toBe('fetch_failed');
  });
});
