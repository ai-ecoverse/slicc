import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RemoteMountCache } from '../../../src/fs/mount/remote-cache.js';

// Each test gets its own dbName so fake-indexeddb state is naturally
// isolated; avoids deleteDatabase races and lets tests run in parallel.
function uniqueDbName(): string {
  return `slicc-mount-cache-test-${Math.random().toString(36).slice(2)}`;
}

describe('RemoteMountCache', () => {
  // Freeze the clock for isStale boundary checks. Without this the test
  // captures `Date.now()` then calls isStale(...) which calls Date.now()
  // again — under load the wall-clock can advance enough between calls
  // to flip a 29 999ms-elapsed timestamp past the 30s TTL boundary.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('re-opens transparently after versionchange (deleteDatabase) drops the cached connection', async () => {
    // Use real timers for this case — fake timers break the indexedDB
    // microtask scheduling that deleteDatabase relies on to deliver
    // versionchange to open connections.
    vi.useRealTimers();
    const dbName = uniqueDbName();
    const cache = new RemoteMountCache({ mountId: 'm1', ttlMs: 30_000, dbName });

    // First call opens + caches the connection.
    await cache.putBody('foo.txt', new Uint8Array([1]), '"e"');
    expect(await cache.getBody('foo.txt')).not.toBeNull();

    // deleteDatabase delivers `versionchange` to open connections. With the
    // handler installed, the cached connection closes and the cached
    // dbPromise is nulled; without it, the next transaction would throw the
    // closing error.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('deleteDatabase blocked — cached connection was not closed'));
    });

    // Next op must re-open transparently against the fresh DB.
    await cache.putBody('bar.txt', new Uint8Array([2]), '"e2"');
    expect(await cache.getBody('bar.txt')).not.toBeNull();
  });
});
