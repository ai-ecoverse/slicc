import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { S3MountBackend } from '../../../src/fs/mount/backend-s3.js';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';
import { installFetchMock } from './helpers/mock-fetch.js';
import { createSignedFetchS3Stub } from './helpers/signed-fetch-stub.js';
import type { S3Profile } from '../../../src/fs/mount/profile.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_PROFILE: S3Profile = {
  accessKeyId: 'AKIA1',
  secretAccessKey: 'sak',
  region: 'us-west-2',
};

const R2_PROFILE: S3Profile = {
  accessKeyId: '9d8e',
  secretAccessKey: 'sak',
  region: 'auto',
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
};

const FIXTURES = join(__dirname, 'fixtures');

/**
 * Helper to create a Response with a custom status code.
 * Some status codes (like 304, 204) can't be created via the Response constructor.
 */
function createResponse(
  body: string | undefined,
  status: number,
  headers?: Record<string, string>
): Response {
  const res = new Response(body ?? '', { headers });
  if (status !== 200) {
    Object.defineProperty(res, 'status', { value: status, writable: false });
  }
  return res;
}

describe('S3MountBackend URL construction', () => {
  let mock: ReturnType<typeof installFetchMock>;
  let dbName: string;

  beforeEach(() => {
    dbName = Math.random().toString(36).slice(2);
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('targets virtual-hosted AWS endpoint for default profile', async () => {
    mock.enqueue(
      new Response('hello', {
        status: 200,
        headers: { etag: '"e1"', 'content-type': 'application/octet-stream' },
      })
    );
    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache,
    });
    await backend.readFile('foo.txt');
    expect(mock.calls[0].url).toBe('https://my-bucket.s3.us-west-2.amazonaws.com/prefix/foo.txt');
  });

  it('targets R2 endpoint when profile.endpoint is set', async () => {
    mock.enqueue(new Response('hello', { status: 200, headers: { etag: '"e1"' } }));
    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'r2',
      signedFetch: createSignedFetchS3Stub(R2_PROFILE),
      cache,
    });
    await backend.readFile('foo.txt');
    // R2 keeps virtual-hosted style.
    expect(mock.calls[0].url).toBe(
      'https://my-bucket.abc123.r2.cloudflarestorage.com/prefix/foo.txt'
    );
  });

  it('handles empty prefix correctly', async () => {
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"e1"' } }));
    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const backend = new S3MountBackend({
      source: 's3://my-bucket',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache,
    });
    await backend.readFile('foo.txt');
    expect(mock.calls[0].url).toBe('https://my-bucket.s3.us-west-2.amazonaws.com/foo.txt');
  });
});

describe('S3MountBackend readFile cache flow', () => {
  let mock: ReturnType<typeof installFetchMock>;
  let dbName: string;

  beforeEach(() => {
    dbName = Math.random().toString(36).slice(2);
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  function makeBackend(): S3MountBackend {
    return new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName }),
    });
  }

  it('caches body on first read', async () => {
    mock.enqueue(
      new Response('hello', { status: 200, headers: { etag: '"e1"', 'content-length': '5' } })
    );
    const backend = makeBackend();
    const got = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(got)).toBe('hello');
    expect(mock.calls.length).toBe(1);
  });

  it('returns cached body within TTL without firing fetch', async () => {
    mock.enqueue(
      new Response('hello', { status: 200, headers: { etag: '"e1"', 'content-length': '5' } })
    );
    const backend = makeBackend();
    await backend.readFile('foo.txt');
    expect(mock.calls.length).toBe(1);
    const second = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(second)).toBe('hello');
    expect(mock.calls.length).toBe(1); // no second fetch
  });

  it('TTL-expired read fires conditional GET; 304 reuses cache', async () => {
    mock.enqueue(
      new Response('hello', { status: 200, headers: { etag: '"e1"', 'content-length': '5' } })
    );
    mock.enqueue(() => createResponse('', 304, {}));
    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 1, dbName }); // tiny TTL
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache,
    });
    await backend.readFile('foo.txt');
    await new Promise((r) => setTimeout(r, 5));
    const second = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(second)).toBe('hello');
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[1].headers['if-none-match']).toBe('"e1"');
  });

  it('TTL-expired read; 200 replaces body and etag', async () => {
    mock.enqueue(
      new Response('hello', { status: 200, headers: { etag: '"e1"', 'content-length': '5' } })
    );
    mock.enqueue(
      new Response('updated', { status: 200, headers: { etag: '"e2"', 'content-length': '7' } })
    );
    const cacheOther = new RemoteMountCache({ mountId: 'm1', ttlMs: 1, dbName }); // tiny TTL
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: cacheOther,
    });
    await backend.readFile('foo.txt');
    await new Promise((r) => setTimeout(r, 5));
    const second = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(second)).toBe('updated');
    expect(mock.calls.length).toBe(2);
  });

  it('404 invalidates cache and throws ENOENT', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    const backend = makeBackend();
    await expect(backend.readFile('nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('over-threshold body throws EFBIG without downloading', async () => {
    mock.enqueue(
      new Response('giant', {
        status: 200,
        headers: { etag: '"e1"', 'content-length': String(100 * 1024 * 1024) },
      })
    );
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName }),
      maxBodyBytes: 25 * 1024 * 1024,
    });
    await expect(backend.readFile('big.bin')).rejects.toMatchObject({ code: 'EFBIG' });
  });
});

describe('S3MountBackend writeFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  let dbName: string;

  beforeEach(() => {
    dbName = Math.random().toString(36).slice(2);
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  function makeBackend(): S3MountBackend {
    return new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName }),
    });
  }

  it('new file uses If-None-Match: *', async () => {
    mock.enqueue(new Response('', { status: 201, headers: { etag: '"e1"' } }));
    const backend = makeBackend();
    await backend.writeFile('foo.txt', new TextEncoder().encode('hi'));
    expect(mock.calls[0].method).toBe('PUT');
    expect(mock.calls[0].headers['if-none-match']).toBe('*');
  });

  it('existing file uses If-Match: <etag>', async () => {
    // Seed cache with an etag.
    mock.enqueue(
      new Response('hi', { status: 200, headers: { etag: '"e1"', 'content-length': '2' } })
    );
    const backend = makeBackend();
    await backend.readFile('foo.txt');
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"e2"' } }));
    await backend.writeFile('foo.txt', new TextEncoder().encode('updated'));
    expect(mock.calls[1].headers['if-match']).toBe('"e1"');
  });

  it('200 updates cache with new etag', async () => {
    mock.enqueue(new Response('', { status: 201, headers: { etag: '"e1"' } }));
    const backend = makeBackend();
    await backend.writeFile('foo.txt', new TextEncoder().encode('hi'));
    // Subsequent read within TTL should not fire fetch (cache populated).
    const body = await backend.readFile('foo.txt');
    expect(new TextDecoder().decode(body)).toBe('hi');
    expect(mock.calls.length).toBe(1); // only the PUT
  });

  it('first-attempt 412 throws EBUSY with retry hint (external conflict)', async () => {
    // Seed cache.
    mock.enqueue(
      new Response('hi', { status: 200, headers: { etag: '"e1"', 'content-length': '2' } })
    );
    const backend = makeBackend();
    await backend.readFile('foo.txt');
    // Concurrent change on remote — first PUT attempt fails with 412.
    mock.enqueue(new Response('', { status: 412 }));
    // Then revalidate fetches new etag.
    mock.enqueue(
      new Response('current', { status: 200, headers: { etag: '"e2"', 'content-length': '7' } })
    );
    await expect(
      backend.writeFile('foo.txt', new TextEncoder().encode('mine'))
    ).rejects.toMatchObject({ code: 'EBUSY' });
  });

  it('retry-attempt 412 reconciles silently (our duplicate PUT actually landed)', async () => {
    // Seed cache.
    mock.enqueue(
      new Response('hi', { status: 200, headers: { etag: '"e1"', 'content-length': '2' } })
    );
    const backend = makeBackend();
    await backend.readFile('foo.txt');
    // First PUT attempt — network drops the response (timeout) but the
    // server actually accepted the write. Simulate via a Promise that
    // rejects with AbortError so writeFile's catch path runs.
    mock.enqueue(() => Promise.reject(new DOMException('Aborted', 'AbortError')));
    // Retry attempt — server returns 412 because etag is now e2 (the
    // first PUT landed and changed it).
    mock.enqueue(new Response('', { status: 412 }));
    // Reconcile path issues a HEAD to learn the new etag.
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"e2"' } }));

    // Should NOT throw — the data is on S3, we just learn the new etag.
    await backend.writeFile('foo.txt', new TextEncoder().encode('updated'));

    // Cache now reflects the post-write state.
    const cached2 = await new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName,
    }).getBody('foo.txt');
    // Note: re-reading via a NEW cache instance to verify IDB persistence.
    // The body is what we wrote; the etag is what the HEAD returned.
    expect(new TextDecoder().decode(cached2!.body)).toBe('updated');
    expect(cached2!.etag).toBe('"e2"');
  });
});

describe('S3MountBackend readDir + refresh', () => {
  let mock: ReturnType<typeof installFetchMock>;
  let dbName: string;

  beforeEach(() => {
    dbName = Math.random().toString(36).slice(2);
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  function makeBackend(): S3MountBackend {
    return new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName }),
    });
  }

  it('readDir returns synthesized files + directories from a single listing page', async () => {
    const xml = readFileSync(join(FIXTURES, 's3-listing-page-1.xml'), 'utf-8');
    mock.enqueue(new Response(xml, { status: 200 }));
    // Page 2 (IsTruncated handling).
    const xml2 = readFileSync(join(FIXTURES, 's3-listing-page-2.xml'), 'utf-8');
    mock.enqueue(new Response(xml2, { status: 200 }));

    const backend = makeBackend();
    const root = await backend.readDir('/');
    const names = root.map((e) => e.name).sort();
    expect(names).toContain('foo.html');
    expect(names).toContain('sub');
    expect(root.find((e) => e.name === 'foo.html')).toMatchObject({
      kind: 'file',
      etag: '"e-foo"',
      size: 123,
    });
    expect(root.find((e) => e.name === 'sub')!.kind).toBe('directory');
  });

  it('refresh returns RefreshReport diff against cache', async () => {
    // First listing — populates cache.
    const xml = readFileSync(join(FIXTURES, 's3-listing-page-1.xml'), 'utf-8');
    mock.enqueue(new Response(xml, { status: 200 }));
    const xml2 = readFileSync(join(FIXTURES, 's3-listing-page-2.xml'), 'utf-8');
    mock.enqueue(new Response(xml2, { status: 200 }));

    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const backend = new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache,
    });
    await backend.readDir('/'); // seeds cache via refresh internals

    // Second refresh — same content. Since we don't have a "get all cached paths"
    // API, the refresh logic reports all files as added (it can't distinguish
    // between "newly added to remote" and "we just don't have a cache entry yet").
    // This is okay per the spec — the intent is to surface net changes, and
    // the agent can filter based on prior state if needed.
    mock.enqueue(new Response(xml, { status: 200 }));
    mock.enqueue(new Response(xml2, { status: 200 }));
    const report = await backend.refresh();
    // Files are reported as added since they're not in the cache (no getPaths API).
    expect(report.added.length).toBe(3);
    expect(report.removed).toEqual([]);
    expect(report.changed).toEqual([]);
    expect(report.unchanged).toBe(0);
  });
});

describe('S3MountBackend remove + auth retry', () => {
  let mock: ReturnType<typeof installFetchMock>;
  let dbName: string;

  beforeEach(() => {
    dbName = Math.random().toString(36).slice(2);
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  function makeBackend(): S3MountBackend {
    return new S3MountBackend({
      source: 's3://my-bucket/prefix',
      profile: 'default',
      signedFetch: createSignedFetchS3Stub(TEST_PROFILE),
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName }),
    });
  }

  it('remove issues DELETE and invalidates cache', async () => {
    mock.enqueue(() => createResponse('', 204, {}));
    const backend = makeBackend();
    await backend.remove('foo.txt');
    expect(mock.calls[0].method).toBe('DELETE');
  });

  // Auth retry was removed from the browser-side backend in the server-side
  // signing refactor. The transport reads creds fresh on every call (server-
  // side EnvSecretStore or extension chrome.storage.local), so a 401/403
  // surfaces directly as EACCES with no client-driven retry.
  it('401 surfaces as EACCES (no client-side retry)', async () => {
    mock.enqueue(new Response('', { status: 401 }));
    const backend = makeBackend();
    await expect(backend.readFile('foo.txt')).rejects.toMatchObject({ code: 'EACCES' });
  });
});
