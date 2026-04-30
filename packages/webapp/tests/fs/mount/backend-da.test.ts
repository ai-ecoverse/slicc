import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { DaMountBackend } from '../../../src/fs/mount/backend-da.js';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';
import { installFetchMock } from './helpers/mock-fetch.js';
import type { DaProfile } from '../../../src/fs/mount/profile.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(__dirname, 'fixtures');

const TEST_DA_PROFILE: DaProfile = {
  identity: 'adobe-ims',
  getBearerToken: async () => 'test-bearer',
};

describe('DaMountBackend readFile', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    indexedDB.deleteDatabase('slicc-mount-cache');
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('hits /source endpoint with Bearer auth', async () => {
    mock.enqueue(new Response('<html>hi</html>', { status: 200, headers: { etag: '"e1"' } }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
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
    indexedDB.deleteDatabase('slicc-mount-cache');
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
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
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
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
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
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
    });
    await backend.readFile('index.html');
    mock.enqueue(new Error('Network timeout'));
    mock.enqueue(new Response('', { status: 412 }));
    mock.enqueue(new Response('', { status: 200, headers: { etag: '"new-e"' } }));
    const newBody = new TextEncoder().encode('updated');
    await backend.writeFile('index.html', newBody);
  });
});

describe('DaMountBackend readDir', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    indexedDB.deleteDatabase('slicc-mount-cache');
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('parses /list response into MountDirEntry', async () => {
    const json = readFileSync(join(FIXTURES, 'da-list-response.json'), 'utf-8');
    mock.enqueue(new Response(json, { status: 200 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
    });
    const entries = await backend.readDir('/');
    expect(entries.find((e) => e.name === 'index.html')!.kind).toBe('file');
    expect(entries.find((e) => e.name === 'blog')!.kind).toBe('directory');
  });
});

describe('DaMountBackend auth retry', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    indexedDB.deleteDatabase('slicc-mount-cache');
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('401 triggers token refresh and retries', async () => {
    mock.enqueue(new Response('', { status: 401 }));
    mock.enqueue(new Response('hi', { status: 200, headers: { etag: '"e1"' } }));
    let ticks = 0;
    const profile: DaProfile = {
      identity: 'adobe-ims',
      getBearerToken: async () => {
        ticks++;
        return ticks === 1 ? 'expired' : 'fresh';
      },
    };
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      profileResolved: profile,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
    });
    const body = await backend.readFile('index.html');
    expect(new TextDecoder().decode(body)).toBe('hi');
    expect(mock.calls[0].headers['authorization']).toBe('Bearer expired');
    expect(mock.calls[1].headers['authorization']).toBe('Bearer fresh');
  });
});

describe('DaMountBackend stat', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    indexedDB.deleteDatabase('slicc-mount-cache');
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
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
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
    indexedDB.deleteDatabase('slicc-mount-cache');
    mock = installFetchMock();
  });
  afterEach(() => mock.restore());

  it('deletes file and invalidates cache', async () => {
    mock.enqueue(new Response('', { status: 200 }));
    const backend = new DaMountBackend({
      source: 'da://my-org/my-repo',
      profile: 'default',
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
    });
    await backend.remove('index.html');
    expect(mock.calls[0].method).toBe('DELETE');
  });
});

describe('DaMountBackend refresh', () => {
  let mock: ReturnType<typeof installFetchMock>;
  beforeEach(() => {
    indexedDB.deleteDatabase('slicc-mount-cache');
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
      profileResolved: TEST_DA_PROFILE,
      cache: new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000 }),
    });
    const report = await backend.refresh();

    expect(report.added).toContain('index.html');
    expect(report.added).toContain('blog/post1.md');
  });
});
