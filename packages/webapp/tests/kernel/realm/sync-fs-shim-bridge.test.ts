import { expect, test } from 'vitest';
import { createSyncFsBridge } from '../../../src/kernel/realm/js-realm-shared.js';
import { SyncFsCache, type SyncFsSnapshot } from '../../../src/kernel/realm/sync-fs-cache.js';
import type { SyncFsXhrBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

function fakeBridge(store: Map<string, Uint8Array>): SyncFsXhrBridge {
  return {
    readFile(p: string): Uint8Array {
      const b = store.get(p);
      if (!b) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return b;
    },
    writeFile(p: string, bytes: Uint8Array): void {
      store.set(p, bytes);
    },
  };
}

function cache(entries: SyncFsSnapshot['entries'] = []): SyncFsCache {
  return new SyncFsCache({ entries });
}

test('readFileSync falls back to the bridge on ENOSYNC (over-cap file)', () => {
  const store = new Map([['/workspace/big.bin', new Uint8Array([1, 2, 3])]]);
  const syncFs = cache([
    { path: '/workspace/big.bin', content: new Uint8Array(0), isDirectory: false, truncated: true },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  expect([...(shim.readFileSync('/workspace/big.bin') as Uint8Array)]).toEqual([1, 2, 3]);
});

test('readFileSync falls back to the bridge on ENOENT (created after snapshot)', () => {
  const store = new Map([['/workspace/new.txt', new TextEncoder().encode('fresh')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  expect(shim.readFileSync('/workspace/new.txt', 'utf8')).toBe('fresh');
});

test('resolves relative paths against cwd before hitting the bridge', () => {
  const store = new Map([['/workspace/rel.txt', new TextEncoder().encode('R')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  expect(shim.readFileSync('rel.txt', 'utf8')).toBe('R');
});

test('without a bridge, over-cap readFileSync still throws ENOSYNC (today behavior)', () => {
  const syncFs = cache([
    { path: '/workspace/big.bin', content: new Uint8Array(0), isDirectory: false, truncated: true },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace');
  expect(() => shim.readFileSync('/workspace/big.bin')).toThrow(/ENOSYNC/);
});

test('writeFileSync write-throughs to the bridge, invalidates cache, read-after-write coherent', () => {
  const store = new Map<string, Uint8Array>();
  const syncFs = cache();
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.writeFileSync('/workspace/out.txt', 'written');
  // Written live through the bridge …
  expect(new TextDecoder().decode(store.get('/workspace/out.txt') as Uint8Array)).toBe('written');
  // … and NOT recorded as a cache mutation (no double-flush).
  const m = syncFs.getMutations();
  expect(m.created.length + m.modified.length).toBe(0);
  // read-after-write is coherent — commitWrite put the bytes in the cache, so
  // the read is served from the cache (no bridge round-trip needed).
  expect(shim.readFileSync('/workspace/out.txt', 'utf8')).toBe('written');
});

test('without a bridge, writeFileSync records a cache mutation (today behavior)', () => {
  const syncFs = cache([{ path: '/workspace', content: new Uint8Array(0), isDirectory: true }]);
  const shim = createSyncFsBridge(syncFs, '/workspace');
  shim.writeFileSync('/workspace/x.txt', 'y');
  const m = syncFs.getMutations();
  expect(m.created.length + m.modified.length).toBeGreaterThan(0);
});

test('exists/stat/readdir are coherent immediately after a bridged writeFileSync', () => {
  const store = new Map<string, Uint8Array>();
  const syncFs = cache([{ path: '/workspace', content: new Uint8Array(0), isDirectory: true }]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.writeFileSync('/workspace/out.txt', 'x');
  // commitWrite put the entry in the cache, so the cache-only metadata ops see it.
  expect(shim.existsSync('/workspace/out.txt')).toBe(true);
  expect((shim.statSync('/workspace/out.txt') as { isFile(): boolean }).isFile()).toBe(true);
  expect(shim.readdirSync('/workspace')).toContain('out.txt');
});

test('a cache hit is served from the snapshot without touching the bridge (fast path)', () => {
  const throwingBridge: SyncFsXhrBridge = {
    readFile() {
      throw new Error('bridge must not be called on a cache hit');
    },
    writeFile() {
      throw new Error('unused');
    },
  };
  const syncFs = cache([
    { path: '/workspace/cached.txt', content: new TextEncoder().encode('hot'), isDirectory: false },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', throwingBridge);
  expect(shim.readFileSync('/workspace/cached.txt', 'utf8')).toBe('hot');
});
