import { expect, test } from 'vitest';
import { createSyncFsBridge } from '../../../src/kernel/realm/js-realm-shared.js';
import { SyncFsCache, type SyncFsSnapshot } from '../../../src/kernel/realm/sync-fs-cache.js';
import type { SyncFsXhrBridge } from '../../../src/kernel/realm/sync-fs-xhr-bridge.js';

function fakeBridge(
  store: Map<string, Uint8Array>,
  dirs: Set<string> = new Set(['/workspace'])
): SyncFsXhrBridge {
  return {
    readFile(p: string): Uint8Array {
      const b = store.get(p);
      if (!b) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return b;
    },
    writeFile(p: string, bytes: Uint8Array): void {
      store.set(p, bytes);
    },
    stat(p: string): { isFile: boolean; isDirectory: boolean; size: number } {
      if (dirs.has(p)) return { isFile: false, isDirectory: true, size: 0 };
      const b = store.get(p);
      if (!b) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return { isFile: true, isDirectory: false, size: b.byteLength };
    },
    readdir(p: string): string[] {
      if (!dirs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      const prefix = p === '/' ? '/' : `${p}/`;
      const names = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      }
      return [...names].sort();
    },
    exists(p: string): boolean {
      return dirs.has(p) || store.has(p);
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

test('writeFileSync propagates a bridge write failure and does NOT commit to cache', () => {
  // If the through-write throws (EIO / SW eviction), commitWrite must be
  // skipped — else a later readFileSync would surface bytes that never landed.
  const syncFs = cache();
  const throwingBridge: SyncFsXhrBridge = {
    readFile() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFile() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
    stat() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readdir() {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    exists() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
  };
  const shim = createSyncFsBridge(syncFs, '/workspace', throwingBridge);
  expect(() => shim.writeFileSync('/workspace/out.txt', 'x')).toThrow(/EIO/);
  expect(syncFs.exists('/workspace/out.txt')).toBe(false); // never committed
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

test('read-after-delete is ENOENT, NOT resurrected via the bridge (Coh#1)', () => {
  // Live store still holds the file (deletes are cache-only in phase-1), so a
  // naive bridge fallback would return OLD bytes and contradict existsSync.
  const store = new Map([['/workspace/config.json', new TextEncoder().encode('OLD')]]);
  const syncFs = cache([
    {
      path: '/workspace/config.json',
      content: new TextEncoder().encode('OLD'),
      isDirectory: false,
    },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.unlinkSync('/workspace/config.json');
  expect(shim.existsSync('/workspace/config.json')).toBe(false);
  expect(() => shim.readFileSync('/workspace/config.json')).toThrow(/ENOENT/);
});

test('rm -r tombstones the subtree: a removed child reads ENOENT, not bridged (Coh#1)', () => {
  const store = new Map([['/workspace/dir/child.txt', new TextEncoder().encode('LIVE')]]);
  const syncFs = cache([
    { path: '/workspace/dir', content: new Uint8Array(0), isDirectory: true },
    {
      path: '/workspace/dir/child.txt',
      content: new TextEncoder().encode('LIVE'),
      isDirectory: false,
    },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.rmSync('/workspace/dir', { recursive: true });
  expect(() => shim.readFileSync('/workspace/dir/child.txt')).toThrow(/ENOENT/);
});

test('re-writing a deleted path clears its tombstone (read returns the new bytes)', () => {
  const store = new Map([['/workspace/f.txt', new TextEncoder().encode('OLD')]]);
  const syncFs = cache([
    { path: '/workspace/f.txt', content: new TextEncoder().encode('OLD'), isDirectory: false },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.unlinkSync('/workspace/f.txt');
  shim.writeFileSync('/workspace/f.txt', 'NEW');
  expect(shim.readFileSync('/workspace/f.txt', 'utf8')).toBe('NEW');
});

test('resolve() normalizes .. before the bridge (sync/async consistency, Con#2)', () => {
  const store = new Map([['/workspace/a.txt', new TextEncoder().encode('A')]]);
  const shim = createSyncFsBridge(cache(), '/workspace/sub', fakeBridge(store));
  // '../a.txt' from /workspace/sub resolves to /workspace/a.txt — a clean path
  // the store has — not the un-normalized '/workspace/sub/../a.txt'.
  expect(shim.readFileSync('../a.txt', 'utf8')).toBe('A');
});

test('a cache hit is served from the snapshot without touching the bridge (fast path)', () => {
  const throwingBridge: SyncFsXhrBridge = {
    readFile() {
      throw new Error('bridge must not be called on a cache hit');
    },
    writeFile() {
      throw new Error('unused');
    },
    stat() {
      throw new Error('bridge must not be called on a cache hit');
    },
    readdir() {
      throw new Error('bridge must not be called on a cache hit');
    },
    exists() {
      throw new Error('bridge must not be called on a cache hit');
    },
  };
  const syncFs = cache([
    { path: '/workspace/cached.txt', content: new TextEncoder().encode('hot'), isDirectory: false },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', throwingBridge);
  expect(shim.readFileSync('/workspace/cached.txt', 'utf8')).toBe('hot');
});

test('statSync falls back to the bridge on cache miss (created after snapshot)', () => {
  const store = new Map([['/workspace/new.txt', new TextEncoder().encode('fresh')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  const s = shim.statSync('/workspace/new.txt');
  expect(s.isFile()).toBe(true);
  expect(s.isDirectory()).toBe(false);
  expect(s.size).toBe(5);
});

test('readdirSync falls back to the bridge on cache miss', () => {
  const store = new Map([
    ['/workspace/a.txt', new TextEncoder().encode('A')],
    ['/workspace/b.txt', new TextEncoder().encode('B')],
  ]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  expect(shim.readdirSync('/workspace').sort()).toEqual(['a.txt', 'b.txt']);
});

test('existsSync falls back to the bridge on cache miss', () => {
  const store = new Map([['/workspace/new.txt', new TextEncoder().encode('fresh')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  expect(shim.existsSync('/workspace/new.txt')).toBe(true);
  expect(shim.existsSync('/workspace/missing.txt')).toBe(false);
});

test('a metadata cache hit is served without touching the bridge (fast path)', () => {
  const throwingBridge: SyncFsXhrBridge = {
    readFile() {
      throw new Error('unused');
    },
    writeFile() {
      throw new Error('unused');
    },
    stat() {
      throw new Error('bridge must not be called on a metadata cache hit');
    },
    readdir() {
      throw new Error('bridge must not be called on a metadata cache hit');
    },
    exists() {
      throw new Error('bridge must not be called on a metadata cache hit');
    },
  };
  const syncFs = cache([
    { path: '/workspace/cached.txt', content: new TextEncoder().encode('hot'), isDirectory: false },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', throwingBridge);
  // Snapshot-covered path → every metadata op stays on the fast path.
  expect(shim.existsSync('/workspace/cached.txt')).toBe(true);
  expect(shim.statSync('/workspace/cached.txt').size).toBe(3);
  // The cache also knows '/workspace' as an implied ancestor dir.
  expect(shim.readdirSync('/workspace')).toContain('cached.txt');
});

test('existsSync returns false on a tombstoned path — does NOT bridge past a delete (Coh#1)', () => {
  // Live store still holds the file (deletes are cache-only), so a naive
  // bridge fallback would resurrect it and contradict read-your-deletes.
  const store = new Map([['/workspace/config.json', new TextEncoder().encode('OLD')]]);
  const syncFs = cache([
    {
      path: '/workspace/config.json',
      content: new TextEncoder().encode('OLD'),
      isDirectory: false,
    },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.unlinkSync('/workspace/config.json');
  expect(shim.existsSync('/workspace/config.json')).toBe(false);
});

test('statSync of a tombstoned path throws ENOENT — does NOT bridge past a delete (Coh#1)', () => {
  const store = new Map([['/workspace/f.txt', new TextEncoder().encode('LIVE')]]);
  const syncFs = cache([
    { path: '/workspace/f.txt', content: new TextEncoder().encode('LIVE'), isDirectory: false },
  ]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.unlinkSync('/workspace/f.txt');
  expect(() => shim.statSync('/workspace/f.txt')).toThrow(/ENOENT/);
});

test('existsSync swallows bridge EIO/EACCES and returns false (Node fs.existsSync contract)', () => {
  // Node's fs.existsSync NEVER throws — a live EIO/EACCES must degrade to
  // false, or ported code guarded by `if (existsSync(p))` would crash.
  const syncFs = cache();
  const eioBridge: SyncFsXhrBridge = {
    readFile() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
    writeFile() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
    stat() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
    readdir() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
    exists() {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
  };
  const shim = createSyncFsBridge(syncFs, '/workspace', eioBridge);
  expect(shim.existsSync('/workspace/anything.txt')).toBe(false);
});

// ── Node-parity sync methods (appendFileSync/rmdirSync/accessSync/lstatSync/
//    realpathSync/truncateSync/cpSync/chmodSync) ─────────────────────────────

function textEntry(path: string, text: string) {
  return { path, content: new TextEncoder().encode(text), isDirectory: false };
}

test('appendFileSync appends to a cache-resident file (write-through)', () => {
  const store = new Map<string, Uint8Array>();
  const syncFs = cache([textEntry('/workspace/log.txt', 'a')]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.appendFileSync('/workspace/log.txt', 'b');
  expect(shim.readFileSync('/workspace/log.txt', 'utf8')).toBe('ab');
  // write-through reached the live store
  expect(new TextDecoder().decode(store.get('/workspace/log.txt'))).toBe('ab');
});

test('appendFileSync creates an absent file (ENOENT → empty base)', () => {
  const store = new Map<string, Uint8Array>();
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  shim.appendFileSync('/workspace/new-log.txt', 'first');
  expect(shim.readFileSync('/workspace/new-log.txt', 'utf8')).toBe('first');
});

test('appendFileSync appends to a bridge-only file (reads live, then writes)', () => {
  const store = new Map([['/workspace/live.txt', new TextEncoder().encode('X')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  shim.appendFileSync('/workspace/live.txt', 'Y');
  expect(new TextDecoder().decode(store.get('/workspace/live.txt'))).toBe('XY');
});

test('rmdirSync removes a directory (maps to rm)', () => {
  const syncFs = cache();
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(new Map()));
  shim.mkdirSync('/workspace/d', { recursive: true });
  expect(shim.existsSync('/workspace/d')).toBe(true);
  shim.rmdirSync('/workspace/d');
  expect(shim.existsSync('/workspace/d')).toBe(false);
});

test('accessSync resolves for an existing path, throws ENOENT otherwise', () => {
  const store = new Map([['/workspace/there.txt', new TextEncoder().encode('1')]]);
  const shim = createSyncFsBridge(cache(), '/workspace', fakeBridge(store));
  expect(() => shim.accessSync('/workspace/there.txt')).not.toThrow();
  expect(() => shim.accessSync('/workspace/missing.txt')).toThrow(/ENOENT/);
});

test('lstatSync mirrors statSync (no symlinks in the sync model)', () => {
  const shim = createSyncFsBridge(cache([textEntry('/workspace/f.txt', 'hello')]), '/workspace');
  const s = shim.lstatSync('/workspace/f.txt');
  expect(s.isFile()).toBe(true);
  expect(s.size).toBe(5);
});

test('realpathSync returns the normalized absolute path when it exists', () => {
  const shim = createSyncFsBridge(cache([textEntry('/workspace/a/b.txt', 'x')]), '/workspace');
  expect(shim.realpathSync('a/../a/b.txt')).toBe('/workspace/a/b.txt');
  expect(() => shim.realpathSync('/workspace/nope.txt')).toThrow(/ENOENT/);
});

test('truncateSync shrinks a file and write-through persists it', () => {
  const store = new Map<string, Uint8Array>();
  const syncFs = cache([textEntry('/workspace/t.txt', 'hello world')]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.truncateSync('/workspace/t.txt', 5);
  expect(shim.readFileSync('/workspace/t.txt', 'utf8')).toBe('hello');
  expect(new TextDecoder().decode(store.get('/workspace/t.txt'))).toBe('hello');
});

test('cpSync copies a single file', () => {
  const shim = createSyncFsBridge(cache([textEntry('/workspace/src.txt', 'copyme')]), '/workspace');
  shim.cpSync('/workspace/src.txt', '/workspace/dst.txt');
  expect(shim.readFileSync('/workspace/dst.txt', 'utf8')).toBe('copyme');
});

test('cpSync recursively copies a directory tree', () => {
  const syncFs = cache();
  const shim = createSyncFsBridge(syncFs, '/workspace');
  shim.mkdirSync('/workspace/tree/sub', { recursive: true });
  shim.writeFileSync('/workspace/tree/a.txt', 'A');
  shim.writeFileSync('/workspace/tree/sub/b.txt', 'B');
  shim.cpSync('/workspace/tree', '/workspace/copy');
  expect(shim.readFileSync('/workspace/copy/a.txt', 'utf8')).toBe('A');
  expect(shim.readFileSync('/workspace/copy/sub/b.txt', 'utf8')).toBe('B');
  expect(shim.statSync('/workspace/copy/sub').isDirectory()).toBe(true);
});

test('chmodSync is a no-op for an existing path, ENOENT for a missing one', () => {
  const shim = createSyncFsBridge(cache([textEntry('/workspace/m.txt', 'x')]), '/workspace');
  expect(() => shim.chmodSync('/workspace/m.txt')).not.toThrow();
  expect(() => shim.chmodSync('/workspace/gone.txt')).toThrow(/ENOENT/);
});

test('appendFileSync does NOT resurrect a tombstoned (deleted-in-script) path', () => {
  const store = new Map([['/workspace/del.txt', new TextEncoder().encode('LIVE')]]);
  const syncFs = cache([textEntry('/workspace/del.txt', 'LIVE')]);
  const shim = createSyncFsBridge(syncFs, '/workspace', fakeBridge(store));
  shim.unlinkSync('/workspace/del.txt'); // tombstone
  // append after delete → treated as a fresh create (empty base), not "LIVE"+data
  shim.appendFileSync('/workspace/del.txt', 'NEW');
  expect(shim.readFileSync('/workspace/del.txt', 'utf8')).toBe('NEW');
});
