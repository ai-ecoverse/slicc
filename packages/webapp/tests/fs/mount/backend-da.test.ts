import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { DaMountBackend } from '../../../src/fs/mount/backend-da.js';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';
import { installFetchMock } from './helpers/mock-fetch.js';
import { createSignedFetchDaStub } from './helpers/signed-fetch-stub.js';
import type { DaProfile } from '../../../src/fs/mount/profile.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, 'fixtures');

const TEST_DA_PROFILE: DaProfile = {
  identity: 'adobe-ims',
  getBearerToken: async () => 'test-bearer',
};

// Each test gets its own dbName so fake-indexeddb state is naturally
// isolated; avoids deleteDatabase races and lets tests run in parallel.
function uniqueDbName(): string {
  return `slicc-mount-cache-test-${Math.random().toString(36).slice(2)}`;
}

function makeCache(): RemoteMountCache {
  return new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName: uniqueDbName() });
}

describe('DaMountBackend readFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('hits /source endpoint with Bearer auth', async () => {
    mock.enqueue(new Response('<html>hi</html>', { status: 200, headers: { etag: '"e1"' } }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    const body = await backend.readFile('index.html');
    expect(new TextDecoder().decode(body)).toBe('<html>hi</html>');
    expect(mock.calls[0].url).toBe('https://admin.da.live/source/my-org/my-repo/index.html');
    expect(mock.calls[0].headers['authorization']).toBe('Bearer test-bearer');
  });
});

describe('DaMountBackend writeFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('uses POST with If-Match', async () => {
    mock.enqueue(
      new Response('hi', { status: 200, headers: { etag: '"e1"', 'content-length': '2' } })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.readFile('index.html');
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"e2"' } }));
    await backend.writeFile('index.html', new TextEncoder().encode('updated'));
    expect(mock.calls[1].headers['if-match']).toBe('"e1"');
    expect(mock.calls[1].method).toBe('POST');
  });

  it('dual-semantics 412 — first attempt external conflict', async () => {
    mock.enqueue(
      new Response('old', { status: 200, headers: { etag: '"old-e"', 'content-length': '3' } })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.readFile('index.html');
    mock.enqueue(new Response('', { status: 412 }));
    const newBody = new TextEncoder().encode('updated');
    try {
      await backend.writeFile('index.html', newBody);
      expect.fail('should throw EBUSY on first-attempt 412');
    } catch (err) {
      expect((err as any).code).toBe('EBUSY');
    }
  });

  it('dual-semantics 412 — retry attempt reconciles', async () => {
    mock.enqueue(
      new Response('old', { status: 200, headers: { etag: '"old-e"', 'content-length': '3' } })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.readFile('index.html');
    // First write attempt: network failure (factory throws).
    mock.enqueue(() => Promise.reject(new DOMException('Aborted', 'AbortError')));
    // Retry-attempt: server returns 412 (our duplicate PUT actually landed).
    mock.enqueue(new Response('', { status: 412 }));
    // Reconcile via HEAD to learn the new etag.
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"new-e"' } }));
    const newBody = new TextEncoder().encode('updated');
    // Should NOT throw — silent reconcile per spec.
    await backend.writeFile('index.html', newBody);
  });
});

describe('DaMountBackend readDir', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('parses /list response into MountDirEntry', async () => {
    const json = readFileSync(join(FIXTURES, 'da-list-response.json'), 'utf-8');
    mock.enqueue(new Response(json, { status: 200 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    const entries = await backend.readDir('/');
    expect(entries.find((e) => e.name === 'index.html')!.kind).toBe('file');
    expect(entries.find((e) => e.name === 'blog')!.kind).toBe('directory');
  });
});

describe('DaMountBackend auth', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  // Auth retry was removed from the browser-side backend in the server-side
  // signing refactor. The transport fetches the bearer token fresh on every
  // call (browser → /api/da-sign-and-forward in CLI; chrome.storage.local
  // for the SW handler in extension), so 401 surfaces directly as EACCES
  // with no client-driven retry.
  it('401 surfaces as EACCES (no client-side retry)', async () => {
    mock.enqueue(new Response('', { status: 401 }));
    const profile: DaProfile = {
      identity: 'adobe-ims',
      getBearerToken: async () => 'tok',
    };
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(profile),
      cache: makeCache(),
    });
    await expect(backend.readFile('index.html')).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('DaMountBackend stat', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('returns file info', async () => {
    mock.enqueue(
      new Response('', { status: 200, headers: { 'content-length': '100', etag: '"e1"' } })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    const stat = await backend.stat('index.html');
    expect(stat.kind).toBe('file');
    expect(stat.size).toBe(100);
    expect(stat.etag).toBe('"e1"');
  });
});

describe('DaMountBackend remove', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('deletes file and invalidates cache', async () => {
    mock.enqueue(new Response('', { status: 200 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.remove('index.html');
    expect(mock.calls[0].method).toBe('DELETE');
  });
});

describe('DaMountBackend refresh', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('walks subdirectories recursively', async () => {
    const listRoot = JSON.stringify([
      { name: 'index', ext: 'html', etag: '"e1"', lastModified: 1714000000000 },
      { name: 'blog', path: '/my-org/my-repo/blog' },
    ]);
    const listBlog = JSON.stringify([
      { name: 'post1', ext: 'md', etag: '"e2"', lastModified: 1714000000000 },
    ]);
    mock.enqueue(new Response(listRoot, { status: 200 }));
    mock.enqueue(new Response(listBlog, { status: 200 }));

    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    const report = await backend.refresh();

    expect(report.added).toContain('index.html');
    expect(report.added).toContain('blog/post1.md');
  });
});
