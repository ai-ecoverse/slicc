import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { AemMountBackend } from '../../../src/fs/mount/backend-aem.js';
import type { DaProfile } from '../../../src/fs/mount/profile.js';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';
import { installFetchMock } from './helpers/mock-fetch.js';
import { createSignedFetchDaStub } from './helpers/signed-fetch-stub.js';

const TEST_PROFILE: DaProfile = {
  identity: 'adobe-ims',
  getBearerToken: async () => 'test-bearer',
};

const BASE = 'https://api.aem.live/my-org/sites/my-site/source';

// Per-test dbName so fake-indexeddb state is naturally isolated.
function makeCache(): RemoteMountCache {
  return new RemoteMountCache({
    mountId: 'm1',
    ttlMs: 30_000,
    dbName: `slicc-mount-cache-test-${Math.random().toString(36).slice(2)}`,
  });
}

function makeBackend(source = 'aem://my-org/my-site'): AemMountBackend {
  return new AemMountBackend({
    source,
    profile: 'default',
    signedFetch: createSignedFetchDaStub(TEST_PROFILE),
    cache: makeCache(),
  });
}

/** A Source Bus listing response. */
function listing(entries: unknown[]): Response {
  return new Response(JSON.stringify(entries), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AemMountBackend source parsing', () => {
  it('rejects a non-aem source', () => {
    expect(() => makeBackend('da://my-org/my-site')).toThrow(/expected aem:\/\/org\/site/);
  });

  it('describes org/site, including a sub-path', () => {
    expect(makeBackend('aem://my-org/my-site/blog').describe().displayName).toBe(
      'my-org/my-site/blog'
    );
  });
});

describe('AemMountBackend readFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('GETs the Source Bus path with Bearer auth', async () => {
    mock.enqueue(
      new Response('<body>hi</body>', {
        status: 200,
        headers: { 'last-modified': 'Wed, 05 Aug 2026 20:29:12 GMT' },
      })
    );
    const body = await makeBackend().readFile('blog/archive.html');
    expect(new TextDecoder().decode(body)).toBe('<body>hi</body>');
    expect(mock.calls[0].url).toBe(`${BASE}/blog/archive.html`);
    expect(mock.calls[0].headers['authorization']).toBe('Bearer test-bearer');
  });

  it('sends no conditional headers — the Source Bus has no ETags', async () => {
    mock.enqueue(
      new Response('one', {
        status: 200,
        headers: { 'last-modified': 'Wed, 05 Aug 2026 20:29:12 GMT' },
      })
    );
    const backend = makeBackend();
    await backend.readFile('a.html');
    expect(mock.calls[0].headers['if-none-match']).toBeUndefined();
    expect(mock.calls[0].headers['if-modified-since']).toBeUndefined();
  });

  it('maps 404 to ENOENT and 403 to EACCES', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    await expect(makeBackend().readFile('missing.html')).rejects.toMatchObject({ code: 'ENOENT' });
    mock.enqueue(new Response('', { status: 403 }));
    await expect(makeBackend().readFile('secret.html')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('rejects a body over maxBodyBytes', async () => {
    mock.enqueue(new Response('x'.repeat(50), { status: 200 }));
    const backend = new AemMountBackend({
      source: 'aem://my-org/my-site',
      profile: 'default',
      maxBodyBytes: 10,
      signedFetch: createSignedFetchDaStub(TEST_PROFILE),
      cache: makeCache(),
    });
    await expect(backend.readFile('big.html')).rejects.toMatchObject({ code: 'EFBIG' });
  });
});

describe('AemMountBackend readDir', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('lists with a trailing slash and splits files from folders', async () => {
    mock.enqueue(
      listing([
        { name: 'blog/', 'content-type': 'application/folder' },
        {
          name: 'index.html',
          size: 616,
          'content-type': 'text/html',
          'last-modified': '2026-08-07T08:41:23.000Z',
        },
      ])
    );
    const entries = await makeBackend().readDir('/');
    expect(mock.calls[0].url).toBe(`${BASE}/`);
    expect(entries).toEqual([
      { name: 'blog', kind: 'directory' },
      {
        name: 'index.html',
        kind: 'file',
        size: 616,
        etag: String(Date.parse('2026-08-07T08:41:23.000Z')),
        lastModified: Date.parse('2026-08-07T08:41:23.000Z'),
      },
    ]);
  });

  it('lists a sub-directory with the trailing slash appended', async () => {
    mock.enqueue(listing([]));
    await makeBackend().readDir('/blog');
    expect(mock.calls[0].url).toBe(`${BASE}/blog/`);
  });

  it('maps a 404 listing to ENOENT — empty folders do not exist', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    await expect(makeBackend().readDir('/gone')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serves a second readDir from the cache', async () => {
    mock.enqueue(
      listing([{ name: 'a.html', size: 1, 'last-modified': '2026-08-07T08:41:23.000Z' }])
    );
    const backend = makeBackend();
    await backend.readDir('/');
    await backend.readDir('/');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('AemMountBackend writeFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  // The Source Bus types a stored object from its path extension, so sending
  // a Content-Type would only create a second opinion the server ignores.
  it('PUTs the raw body with no Content-Type header', async () => {
    mock.enqueue(new Response('', { status: 201 }));
    await makeBackend().writeFile('blog/post.html', new TextEncoder().encode('<body>x</body>'));
    expect(mock.calls[0].method).toBe('PUT');
    expect(mock.calls[0].url).toBe(`${BASE}/blog/post.html`);
    expect(mock.calls[0].headers['content-type']).toBeUndefined();
    expect(new TextDecoder().decode(mock.calls[0].body)).toBe('<body>x</body>');
  });

  it('writes unguarded when nothing was read first', async () => {
    mock.enqueue(new Response('', { status: 201 }));
    await makeBackend().writeFile('new.html', new TextEncoder().encode('x'));
    expect(mock.calls.map((c) => c.method)).toEqual(['PUT']);
  });

  it('HEADs before overwriting a file it has read, then writes', async () => {
    const lm = 'Wed, 05 Aug 2026 20:29:12 GMT';
    mock.enqueue(new Response('one', { status: 200, headers: { 'last-modified': lm } }));
    const backend = makeBackend();
    await backend.readFile('a.html');
    mock.enqueue(new Response('', { status: 200, headers: { 'last-modified': lm } }));
    mock.enqueue(new Response('', { status: 201 }));
    await backend.writeFile('a.html', new TextEncoder().encode('two'));
    expect(mock.calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'PUT']);
  });

  it('fails EBUSY instead of clobbering a remote that moved', async () => {
    mock.enqueue(
      new Response('one', {
        status: 200,
        headers: { 'last-modified': 'Wed, 05 Aug 2026 20:29:12 GMT' },
      })
    );
    const backend = makeBackend();
    await backend.readFile('a.html');
    mock.enqueue(
      new Response('', {
        status: 200,
        headers: { 'last-modified': 'Thu, 06 Aug 2026 09:00:00 GMT' },
      })
    );
    await expect(
      backend.writeFile('a.html', new TextEncoder().encode('two'))
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(mock.calls.map((c) => c.method)).toEqual(['GET', 'HEAD']);
  });

  it('recreates a file deleted remotely rather than failing the guard', async () => {
    mock.enqueue(
      new Response('one', {
        status: 200,
        headers: { 'last-modified': 'Wed, 05 Aug 2026 20:29:12 GMT' },
      })
    );
    const backend = makeBackend();
    await backend.readFile('a.html');
    mock.enqueue(new Response('', { status: 404 }));
    mock.enqueue(new Response('', { status: 201 }));
    await backend.writeFile('a.html', new TextEncoder().encode('two'));
    expect(mock.calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'PUT']);
  });

  it('maps 403 to EACCES', async () => {
    mock.enqueue(new Response('', { status: 403 }));
    await expect(
      makeBackend().writeFile('a.html', new TextEncoder().encode('x'))
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('AemMountBackend stat', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('answers from the parent listing without a per-file HEAD', async () => {
    mock.enqueue(
      listing([
        { name: 'blog/', 'content-type': 'application/folder' },
        {
          name: 'index.html',
          size: 616,
          'content-type': 'text/html',
          'last-modified': '2026-08-07T08:41:23.000Z',
        },
      ])
    );
    const backend = makeBackend();
    const file = await backend.stat('index.html');
    const dir = await backend.stat('blog');
    expect(file).toEqual({
      kind: 'file',
      size: 616,
      mtime: Date.parse('2026-08-07T08:41:23.000Z'),
      etag: String(Date.parse('2026-08-07T08:41:23.000Z')),
    });
    expect(dir.kind).toBe('directory');
    // One listing served both stats.
    expect(mock.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('reports the mount root as a directory without a request', async () => {
    expect(await makeBackend().stat('/')).toEqual({ kind: 'directory', size: 0, mtime: 0 });
    expect(mock.calls).toHaveLength(0);
  });

  it('throws ENOENT when the parent listing does not hold the name', async () => {
    mock.enqueue(listing([{ name: 'other.html', size: 1 }]));
    await expect(makeBackend().stat('index.html')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws ENOENT when the parent itself is gone', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    await expect(makeBackend().stat('gone/index.html')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('AemMountBackend remove', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('DELETEs and accepts the 204', async () => {
    mock.enqueue(new Response(null, { status: 204 }));
    await makeBackend().remove('blog/post.html');
    expect(mock.calls[0].method).toBe('DELETE');
    expect(mock.calls[0].url).toBe(`${BASE}/blog/post.html`);
  });

  it('maps 404 to ENOENT', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    await expect(makeBackend().remove('gone.html')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('AemMountBackend refresh', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('walks folders and classifies files by modification time', async () => {
    const lm = '2026-08-07T08:41:23.000Z';
    // Seed the cache with a body whose surrogate matches `lm`.
    mock.enqueue(
      new Response('cached', {
        status: 200,
        headers: { 'last-modified': 'Fri, 07 Aug 2026 08:41:23 GMT' },
      })
    );
    const backend = makeBackend();
    await backend.readFile('index.html');

    mock.enqueue(
      listing([
        { name: 'blog/', 'content-type': 'application/folder' },
        { name: 'index.html', size: 1, 'last-modified': lm },
      ])
    );
    mock.enqueue(listing([{ name: 'post.html', size: 2, 'last-modified': lm }]));
    const report = await backend.refresh();
    expect(report.added).toEqual(['blog/post.html']);
    expect(report.unchanged).toBe(1);
    expect(report.changed).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('marks a file changed when its modification time moved', async () => {
    mock.enqueue(
      new Response('cached', {
        status: 200,
        headers: { 'last-modified': 'Fri, 07 Aug 2026 08:41:23 GMT' },
      })
    );
    const backend = makeBackend();
    await backend.readFile('index.html');
    mock.enqueue(
      listing([{ name: 'index.html', size: 1, 'last-modified': '2026-08-09T10:00:00.000Z' }])
    );
    const report = await backend.refresh();
    expect(report.changed).toEqual(['index.html']);
  });

  it('treats an emptied folder as empty, not as an error', async () => {
    mock.enqueue(new Response('', { status: 404 }));
    const report = await makeBackend().refresh();
    expect(report.errors).toEqual([]);
    expect(report.added).toEqual([]);
  });
});

describe('AemMountBackend lifecycle', () => {
  it('throws EBADF after close', async () => {
    const backend = makeBackend();
    await backend.close();
    await expect(backend.readFile('a.html')).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('mkdir is a no-op — Source Bus folders are virtual', async () => {
    await expect(makeBackend().mkdir('/blog')).resolves.toBeUndefined();
  });
});
