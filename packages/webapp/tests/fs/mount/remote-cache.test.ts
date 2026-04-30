import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';

// Each test gets its own dbName so fake-indexeddb state is naturally
// isolated; avoids deleteDatabase races and lets tests run in parallel.
function uniqueDbName(): string {
  return `slicc-mount-cache-test-${Math.random().toString(36).slice(2)}`;
}

describe('RemoteMountCache', () => {
  it('isStale: under TTL is fresh', () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const now = Date.now();
    expect(cache.isStale(now - 1_000)).toBe(false);
    expect(cache.isStale(now - 29_999)).toBe(false);
  });

  it('isStale: at or beyond TTL is stale', () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const now = Date.now();
    expect(cache.isStale(now - 30_000)).toBe(true);
    expect(cache.isStale(now - 60_000)).toBe(true);
  });

  it('isStale honors per-call TTL override', () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const cachedAt = Date.now() - 10_000;
    expect(cache.isStale(cachedAt)).toBe(false); // default 30s
    expect(cache.isStale(cachedAt, 5_000)).toBe(true); // override 5s
  });
});

describe('RemoteMountCache.listing', () => {
  it('getListing returns null on cache miss', async () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    expect(await cache.getListing('foo')).toBeNull();
  });

  it('round-trips a listing', async () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const entries = [
      { name: 'a.html', kind: 'file' as const, size: 12, etag: '"e1"' },
      { name: 'sub', kind: 'directory' as const },
    ];
    await cache.putListing('foo', entries);
    const got = await cache.getListing('foo');
    expect(got).not.toBeNull();
    expect(got!.entries).toEqual(entries);
    expect(typeof got!.cachedAt).toBe('number');
  });

  it('invalidateListing removes the entry', async () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    await cache.putListing('foo', [{ name: 'a', kind: 'file' }]);
    await cache.invalidateListing('foo');
    expect(await cache.getListing('foo')).toBeNull();
  });

  it('namespaces by mountId — two mounts in same DB do not see each other', async () => {
    const dbName = uniqueDbName();
    const a = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const b = new RemoteMountCache({ mountId: 'm2', ttlMs: 30_000, dbName });
    await a.putListing('foo', [{ name: 'a', kind: 'file' }]);
    expect(await b.getListing('foo')).toBeNull();
  });
});

describe('RemoteMountCache.bodies', () => {
  it('round-trips a body', async () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const body = new TextEncoder().encode('hello');
    await cache.putBody('foo.txt', body, '"e1"');
    const got = await cache.getBody('foo.txt');
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe('hello');
    expect(got!.etag).toBe('"e1"');
    expect(got!.size).toBe(body.byteLength);
  });

  it('invalidateBody removes the entry', async () => {
    const cache = new RemoteMountCache({
      mountId: 'm1',
      ttlMs: 30_000,
      dbName: uniqueDbName(),
    });
    const body = new TextEncoder().encode('x');
    await cache.putBody('foo.txt', body, '"e1"');
    await cache.invalidateBody('foo.txt');
    expect(await cache.getBody('foo.txt')).toBeNull();
  });

  it('clearMount drops all entries for this mountId only', async () => {
    const dbName = uniqueDbName();
    const a = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });
    const b = new RemoteMountCache({ mountId: 'm2', ttlMs: 30_000, dbName });
    await a.putBody('foo.txt', new Uint8Array([1]), '"a"');
    await b.putBody('bar.txt', new Uint8Array([2]), '"b"');
    await a.clearMount();
    expect(await a.getBody('foo.txt')).toBeNull();
    expect(await b.getBody('bar.txt')).not.toBeNull();
  });
});
