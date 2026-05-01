import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleDaSignAndForward,
  handleS3SignAndForward,
  type S3SignAndForwardEnvelope,
} from '../../src/secrets/sign-and-forward.js';
import type { Secret, SecretEntry, SecretStore } from '../../src/secrets/types.js';

// ----------------- helpers -----------------

class InMemorySecretStore implements SecretStore {
  private secrets = new Map<string, Secret>();

  set(name: string, value: string, domains: string[]): void {
    this.secrets.set(name, { name, value, domains });
  }

  get(name: string): Secret | null {
    return this.secrets.get(name) ?? null;
  }

  delete(name: string): void {
    this.secrets.delete(name);
  }

  list(): SecretEntry[] {
    return Array.from(this.secrets.values()).map(({ name, domains }) => ({ name, domains }));
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

function installFetchMock(responses: MockResponse[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected fetch call to ${String(url)} (no more queued responses)`);
    }
    const headers = new Headers(next.headers ?? {});
    return new globalThis.Response((next.body ?? new Uint8Array(0)) as RequestInit['body'], {
      status: next.status,
      headers,
    });
  }) as typeof fetch;
  return { calls };
}

function makeRes(): {
  res: Response;
  body: () => unknown;
  status: () => number;
} {
  let statusCode = 200;
  let payload: unknown = undefined;
  let headersSent = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(data: unknown) {
      payload = data;
      headersSent = true;
      return this;
    },
    get headersSent() {
      return headersSent;
    },
  } as unknown as Response;
  return {
    res,
    body: () => payload,
    status: () => statusCode,
  };
}

function makeReq<T>(body: T): Request {
  return { body } as unknown as Request;
}

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ----------------- S3 tests -----------------

describe('handleS3SignAndForward — validation', () => {
  let store: InMemorySecretStore;
  beforeEach(() => {
    store = new InMemorySecretStore();
  });

  it('rejects invalid profile name (regex)', async () => {
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({
        profile: 'aws/etc/passwd',
        method: 'GET',
        bucket: 'b',
        key: 'k',
      }),
      res,
      store
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_profile');
  });

  it('rejects empty profile name', async () => {
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: '', method: 'GET', bucket: 'b', key: 'k' }),
      res,
      store
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_profile');
  });

  it('rejects unknown method', async () => {
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({
        profile: 'aws',
        method: 'PATCH',
        bucket: 'b',
        key: 'k',
      } as unknown as S3SignAndForwardEnvelope),
      res,
      store
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_request');
  });

  it('rejects empty bucket', async () => {
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: '', key: 'k' }),
      res,
      store
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_request');
  });

  it('returns profile_not_configured with actionable message when secret missing', async () => {
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: 'b', key: 'k' }),
      res,
      store
    );
    expect(status()).toBe(400);
    const payload = body() as { errorCode: string; error: string };
    expect(payload.errorCode).toBe('profile_not_configured');
    expect(payload.error).toContain("profile 'aws' missing required field 'access_key_id'");
    expect(payload.error).toContain('secret set s3.aws.access_key_id');
  });

  it('detects partial config (missing secret_access_key)', async () => {
    store.set('s3.aws.access_key_id', 'AKIA1', ['*.amazonaws.com']);
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: 'b', key: 'k' }),
      res,
      store
    );
    expect(status()).toBe(400);
    const payload = body() as { errorCode: string; error: string };
    expect(payload.errorCode).toBe('profile_not_configured');
    expect(payload.error).toContain("missing required field 'secret_access_key'");
  });
});

describe('handleS3SignAndForward — successful sign + forward', () => {
  let store: InMemorySecretStore;
  beforeEach(() => {
    store = new InMemorySecretStore();
    store.set('s3.aws.access_key_id', 'AKIDEXAMPLE', ['*.amazonaws.com']);
    store.set('s3.aws.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', [
      '*.amazonaws.com',
    ]);
    store.set('s3.aws.region', 'us-east-1', ['*.amazonaws.com']);
  });

  it('virtual-hosted: builds bucket-prefixed URL and signs the request', async () => {
    const { calls } = installFetchMock([
      {
        status: 200,
        headers: { etag: '"e1"', 'content-type': 'text/plain' },
        body: new TextEncoder().encode('hello'),
      },
    ]);
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: 'my-bucket', key: 'foo/bar.txt' }),
      res,
      store
    );

    expect(status()).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/foo/bar.txt');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers['x-amz-content-sha256']).toBeDefined();
    expect(headers['x-amz-date']).toBeDefined();

    const reply = body() as {
      ok: true;
      status: number;
      headers: Record<string, string>;
      bodyBase64: string;
    };
    expect(reply.ok).toBe(true);
    expect(reply.status).toBe(200);
    expect(reply.headers.etag).toBe('"e1"');
    expect(Buffer.from(reply.bodyBase64, 'base64').toString('utf-8')).toBe('hello');
  });

  it('honors --path-style: bucket lives in the path, not the host', async () => {
    store.set('s3.r2.access_key_id', 'AKIDEXAMPLE', ['*.r2.cloudflarestorage.com']);
    store.set('s3.r2.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', [
      '*.r2.cloudflarestorage.com',
    ]);
    store.set('s3.r2.endpoint', 'https://account.r2.cloudflarestorage.com', [
      '*.r2.cloudflarestorage.com',
    ]);
    store.set('s3.r2.path_style', 'true', ['*.r2.cloudflarestorage.com']);

    const { calls } = installFetchMock([{ status: 200, body: new Uint8Array() }]);
    const { res, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'r2', method: 'GET', bucket: 'my-bucket', key: 'foo.txt' }),
      res,
      store
    );

    expect(status()).toBe(200);
    expect(calls[0].url).toBe('https://account.r2.cloudflarestorage.com/my-bucket/foo.txt');
  });

  it('honors custom endpoint without --path-style: virtual-hosted on custom host', async () => {
    store.set('s3.r2.access_key_id', 'AKIDEXAMPLE', ['*.r2.cloudflarestorage.com']);
    store.set('s3.r2.secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', [
      '*.r2.cloudflarestorage.com',
    ]);
    store.set('s3.r2.endpoint', 'https://account.r2.cloudflarestorage.com', [
      '*.r2.cloudflarestorage.com',
    ]);

    const { calls } = installFetchMock([{ status: 200, body: new Uint8Array() }]);
    const { res, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'r2', method: 'GET', bucket: 'my-bucket', key: 'foo.txt' }),
      res,
      store
    );

    expect(status()).toBe(200);
    expect(calls[0].url).toBe('https://my-bucket.account.r2.cloudflarestorage.com/foo.txt');
  });

  it('round-trips a body via base64 (PUT with content)', async () => {
    const { calls } = installFetchMock([{ status: 200, headers: { etag: '"e2"' } }]);
    const { res, status } = makeRes();
    const payload = new TextEncoder().encode('hello world');
    await handleS3SignAndForward(
      makeReq({
        profile: 'aws',
        method: 'PUT',
        bucket: 'my-bucket',
        key: 'foo.txt',
        bodyBase64: Buffer.from(payload).toString('base64'),
      }),
      res,
      store
    );

    expect(status()).toBe(200);
    const sentBody = calls[0].init?.body;
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sentBody as Uint8Array)).toBe('hello world');
  });

  it('passes query params into the URL', async () => {
    const { calls } = installFetchMock([{ status: 200, body: new Uint8Array() }]);
    const { res } = makeRes();
    await handleS3SignAndForward(
      makeReq({
        profile: 'aws',
        method: 'GET',
        bucket: 'my-bucket',
        key: '',
        query: { 'list-type': '2', prefix: 'foo/' },
      }),
      res,
      store
    );

    expect(calls[0].url).toBe(
      'https://my-bucket.s3.us-east-1.amazonaws.com/?list-type=2&prefix=foo%2F'
    );
  });

  it('strips hop-by-hop headers from the response envelope', async () => {
    installFetchMock([
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
    const { res, body } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: 'b', key: 'k' }),
      res,
      store
    );

    const reply = body() as { headers: Record<string, string> };
    expect(reply.headers.etag).toBe('"e3"');
    expect(reply.headers['content-type']).toBe('application/octet-stream');
    expect(reply.headers.connection).toBeUndefined();
    expect(reply.headers['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 on upstream network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    const { res, body, status } = makeRes();
    await handleS3SignAndForward(
      makeReq({ profile: 'aws', method: 'GET', bucket: 'b', key: 'k' }),
      res,
      store
    );

    expect(status()).toBe(502);
    expect((body() as { errorCode: string }).errorCode).toBe('fetch_failed');
  });
});

// ----------------- DA tests -----------------

describe('handleDaSignAndForward', () => {
  it('rejects missing imsToken', async () => {
    const { res, body, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({ method: 'GET', path: '/source/o/r/k' }) as unknown as Request,
      res
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_request');
  });

  it('rejects empty imsToken', async () => {
    const { res, body, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({ imsToken: '', method: 'GET', path: '/source/o/r/k' }),
      res
    );
    expect(status()).toBe(400);
    expect((body() as { errorCode: string }).errorCode).toBe('invalid_request');
  });

  it('rejects path without leading slash', async () => {
    const { res, body, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({ imsToken: 'tok', method: 'GET', path: 'source/o/r/k' }),
      res
    );
    expect(status()).toBe(400);
    expect((body() as { error: string }).error).toContain('starting with /');
  });

  it('attaches Bearer token and forwards to admin.da.live', async () => {
    const { calls } = installFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"hello":"da"}'),
      },
    ]);
    const { res, body, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({
        imsToken: 'ims-token-here',
        method: 'GET',
        path: '/source/my-org/my-repo/foo.html',
      }),
      res
    );

    expect(status()).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://admin.da.live/source/my-org/my-repo/foo.html');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ims-token-here');

    const reply = body() as { ok: true; bodyBase64: string };
    expect(Buffer.from(reply.bodyBase64, 'base64').toString('utf-8')).toBe('{"hello":"da"}');
  });

  it('appends query params to the URL', async () => {
    const { calls } = installFetchMock([{ status: 200, body: new Uint8Array() }]);
    const { res } = makeRes();
    await handleDaSignAndForward(
      makeReq({
        imsToken: 'tok',
        method: 'GET',
        path: '/list/my-org/my-repo',
        query: { recursive: 'true' },
      }),
      res
    );
    expect(calls[0].url).toBe('https://admin.da.live/list/my-org/my-repo?recursive=true');
  });

  it('round-trips a body via base64 (PUT with content)', async () => {
    const { calls } = installFetchMock([{ status: 201, headers: { etag: '"e1"' } }]);
    const { res, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({
        imsToken: 'tok',
        method: 'PUT',
        path: '/source/o/r/foo.html',
        bodyBase64: Buffer.from('<html></html>').toString('base64'),
      }),
      res
    );

    expect(status()).toBe(200);
    const sentBody = calls[0].init?.body;
    expect(sentBody).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sentBody as Uint8Array)).toBe('<html></html>');
  });

  it('returns 502 on upstream network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as typeof fetch;
    const { res, body, status } = makeRes();
    await handleDaSignAndForward(
      makeReq({ imsToken: 'tok', method: 'GET', path: '/source/o/r/k' }),
      res
    );

    expect(status()).toBe(502);
    expect((body() as { errorCode: string }).errorCode).toBe('fetch_failed');
  });
});
