import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaMountBackend } from '../../../src/fs/mount/backend-da.js';
import type { DaProfile } from '../../../src/fs/mount/profile.js';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';
import { installFetchMock } from './helpers/mock-fetch.js';
import { createSignedFetchDaStub } from './helpers/signed-fetch-stub.js';

const FIXTURES = join(__dirname, 'fixtures');

const TEST_DA_PROFILE: DaProfile = {
  identity: 'adobe-ims',
  getBearerToken: async () => 'test-bearer',
};

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

    mock.enqueue(() => Promise.reject(new DOMException('Aborted', 'AbortError')));

    mock.enqueue(new Response('', { status: 412 }));

    mock.enqueue(new Response('', { status: 200, headers: { etag: '"new-e"' } }));
    const newBody = new TextEncoder().encode('updated');

    await backend.writeFile('index.html', newBody);
  });

  it('wraps body in multipart/form-data with the right MIME from the file extension', async () => {
    mock.enqueue(new Response('', { status: 201, headers: { etag: '"new-e"' } }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.writeFile('test.html', new TextEncoder().encode('foo\n'));

    const call = mock.calls[0];
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toMatch(
      /^multipart\/form-data; boundary=----SliccFormBoundary[0-9a-f]{32}$/
    );

    expect(call.headers['if-none-match']).toBe('*');
    expect(call.headers['if-match']).toBeUndefined();

    const parsed = await new Response(call.body as unknown as BodyInit, {
      headers: { 'content-type': call.headers['content-type'] },
    }).formData();
    const file = parsed.get('data') as File;
    expect(file.name).toBe('test.html');
    expect(file.type).toBe('text/html');
    expect(await file.text()).toBe('foo\n');
  });

  it('uses application/json mime for .json files', async () => {
    mock.enqueue(new Response('', { status: 201 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.writeFile('config.json', new TextEncoder().encode('{}'));
    const bodyStr = new TextDecoder().decode(mock.calls[0].body as Uint8Array);
    expect(bodyStr).toContain('Content-Type: application/json');
    expect(bodyStr).toContain('filename="config.json"');
  });

  it('strips W/ weak-ETag prefix from GET response before caching so If-Match uses the strong form', async () => {
    mock.enqueue(
      new Response('{"data":[]}', {
        status: 200,
        headers: { etag: 'W/"ed1fe6b5"', 'content-length': '11' },
      })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.readFile('data/staffing.json');
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"ed1fe6b5"' } }));
    await backend.writeFile('data/staffing.json', new TextEncoder().encode('{"data":[]}'));

    expect(mock.calls[1].headers['if-match']).toBe('"ed1fe6b5"');
  });

  it('strips W/ weak-ETag prefix from stale cache entries at write time', async () => {
    const cache = makeCache();

    await cache.putBody('data/staffing.json', new TextEncoder().encode('{"data":[]}'), 'W/"stale"');
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache,
    });
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"stale"' } }));
    await backend.writeFile('data/staffing.json', new TextEncoder().encode('{"data":[1]}'));
    expect(mock.calls[0].headers['if-match']).toBe('"stale"');
  });

  it('omits if-match (instead of sending empty value) when cached etag is empty', async () => {
    mock.enqueue(
      new Response('hi', { status: 200, headers: { 'content-length': '2' } })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache: makeCache(),
    });
    await backend.readFile('test.html');
    mock.enqueue(new Response('', { status: 201 }));
    await backend.writeFile('test.html', new TextEncoder().encode('updated'));

    expect(mock.calls[1].headers['if-match']).toBeUndefined();
    expect(mock.calls[1].headers['if-none-match']).toBeUndefined();
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

  it('backfills the parent listing after a HEAD so subsequent stats avoid the round-trip', async () => {
    const cache = makeCache();

    mock.enqueue(
      new Response(JSON.stringify([{ name: 'index', ext: 'html', lastModified: 1714000000000 }]), {
        status: 200,
      })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache,
    });
    await backend.readDir('');

    mock.enqueue(
      new Response('', {
        status: 200,
        headers: {
          'content-length': '14349',
          etag: '"abc"',
          'last-modified': 'Sun, 04 May 2026 16:14:00 GMT',
        },
      })
    );
    const stat1 = await backend.stat('index.html');
    expect(stat1.kind).toBe('file');
    expect(stat1.size).toBe(14349);
    expect(stat1.etag).toBe('"abc"');

    const callsBefore = mock.calls.length;
    const stat2 = await backend.stat('index.html');
    expect(mock.calls.length).toBe(callsBefore);
    expect(stat2.size).toBe(14349);
    expect(stat2.etag).toBe('"abc"');
  });

  it('returns immediately for directories from listing without HEAD', async () => {
    const cache = makeCache();
    mock.enqueue(
      new Response(JSON.stringify([{ name: 'blog', lastModified: 1714000000000 }]), {
        status: 200,
      })
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache,
    });
    await backend.readDir('');

    const callsBefore = mock.calls.length;
    const stat = await backend.stat('blog');
    expect(stat.kind).toBe('directory');

    expect(mock.calls.length).toBe(callsBefore);
  });

  it('returns ENOENT immediately when listing is fresh and entry is absent', async () => {
    const cache = makeCache();
    mock.enqueue(new Response(JSON.stringify([{ name: 'index', ext: 'html' }]), { status: 200 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache,
    });
    await backend.readDir('');

    const callsBefore = mock.calls.length;
    await expect(backend.stat('does-not-exist.html')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(mock.calls.length).toBe(callsBefore);
  });
});

describe('DaMountBackend remove cache invalidation', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('invalidates the parent listing for a root-level file (regression for ls-still-shows-deleted)', async () => {
    const cache = makeCache();

    mock.enqueue(
      new Response(
        JSON.stringify([
          { name: 'test', ext: 'html', lastModified: 1714000000000 },
          { name: 'index', ext: 'html', lastModified: 1714000000000 },
        ]),
        { status: 200 }
      )
    );
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      signedFetch: createSignedFetchDaStub(TEST_DA_PROFILE),
      cache,
    });
    let entries = await backend.readDir('');
    expect(entries.map((e) => e.name)).toContain('test.html');

    mock.enqueue(new Response(null, { status: 204 }));
    await backend.remove('test.html');

    mock.enqueue(
      new Response(JSON.stringify([{ name: 'index', ext: 'html', lastModified: 1714000000000 }]), {
        status: 200,
      })
    );
    entries = await backend.readDir('');
    expect(entries.map((e) => e.name)).not.toContain('test.html');
    expect(entries.map((e) => e.name)).toContain('index.html');
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
