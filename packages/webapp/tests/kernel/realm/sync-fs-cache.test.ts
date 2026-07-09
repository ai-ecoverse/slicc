/**
 * Unit tests for SyncFsCache — the pure in-memory FS tree backing
 * synchronous fs APIs in the realm.
 */

import { describe, expect, it } from 'vitest';
import { SyncFsCache, type SyncFsSnapshot } from '../../../src/kernel/realm/sync-fs-cache.js';

function textEntry(path: string, text: string, isDirectory = false) {
  return { path, content: new TextEncoder().encode(text), isDirectory };
}

function textOf(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

function emptySnapshot(): SyncFsSnapshot {
  return { entries: [] };
}

describe('SyncFsCache', () => {
  it('readFile sees writeFile within same execution', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('hello'));
    expect(textOf(cache.readFile('/workspace/a.txt'))).toBe('hello');
  });

  it('readFile throws ENOENT for missing file', () => {
    const cache = new SyncFsCache(emptySnapshot());
    expect(() => cache.readFile('/workspace/missing.txt')).toThrow();
    try {
      cache.readFile('/workspace/missing.txt');
      throw new Error('expected readFile to throw');
    } catch (e: any) {
      expect(e.code).toBe('ENOENT');
    }
  });

  it('existsSync returns false for missing, true after writeFile', () => {
    const cache = new SyncFsCache(emptySnapshot());
    expect(cache.exists('/workspace/x.txt')).toBe(false);
    cache.writeFile('/workspace/x.txt', new Uint8Array());
    expect(cache.exists('/workspace/x.txt')).toBe(true);
  });

  it('mkdir + readdir lists entries', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    cache.writeFile('/workspace/dir/b.txt', new Uint8Array());
    expect(cache.readdir('/workspace/dir').sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('mkdir recursive creates intermediate dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/a/b/c', true);
    expect(cache.exists('/workspace/a')).toBe(true);
    expect(cache.exists('/workspace/a/b')).toBe(true);
    expect(cache.exists('/workspace/a/b/c')).toBe(true);
    expect(cache.stat('/workspace/a/b/c').isDirectory).toBe(true);
  });

  it('rm removes files from cache', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new Uint8Array());
    cache.rm('/workspace/f.txt');
    expect(cache.exists('/workspace/f.txt')).toBe(false);
  });

  it('rm recursive removes dir and children', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    cache.rm('/workspace/dir', true);
    expect(cache.exists('/workspace/dir')).toBe(false);
    expect(cache.exists('/workspace/dir/a.txt')).toBe(false);
  });

  it('rm non-recursive throws on non-empty dir', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.mkdir('/workspace/dir', true);
    cache.writeFile('/workspace/dir/a.txt', new Uint8Array());
    expect(() => cache.rm('/workspace/dir')).toThrow();
  });

  it('copyFile copies content', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/src.txt', new TextEncoder().encode('content'));
    cache.copyFile('/workspace/src.txt', '/workspace/dest.txt');
    expect(textOf(cache.readFile('/workspace/dest.txt'))).toBe('content');
  });

  it('rename moves a file', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/old.txt', new TextEncoder().encode('data'));
    cache.rename('/workspace/old.txt', '/workspace/new.txt');
    expect(cache.exists('/workspace/old.txt')).toBe(false);
    expect(textOf(cache.readFile('/workspace/new.txt'))).toBe('data');
  });

  it('unlink removes file, throws on directory', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new Uint8Array());
    cache.unlink('/workspace/f.txt');
    expect(cache.exists('/workspace/f.txt')).toBe(false);

    cache.mkdir('/workspace/dir');
    expect(() => cache.unlink('/workspace/dir')).toThrow();
  });

  it('mkdtemp creates unique dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    const dir1 = cache.mkdtemp('/workspace/test-');
    const dir2 = cache.mkdtemp('/workspace/test-');
    expect(dir1).not.toBe(dir2);
    expect(cache.exists(dir1)).toBe(true);
    expect(cache.exists(dir2)).toBe(true);
    expect(cache.stat(dir1).isDirectory).toBe(true);
  });

  it('stat returns correct shape for files and dirs', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/f.txt', new TextEncoder().encode('abc'));
    const fileStat = cache.stat('/workspace/f.txt');
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.size).toBe(3);

    cache.mkdir('/workspace/dir');
    const dirStat = cache.stat('/workspace/dir');
    expect(dirStat.isFile).toBe(false);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.size).toBe(0);

    expect(() => cache.stat('/workspace/missing')).toThrow();
  });

  it('getMutations: new file shows as created', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/new.txt', new TextEncoder().encode('x'));
    const mutations = cache.getMutations();
    expect(mutations.created.map((c) => c.path)).toContain('/workspace/new.txt');
    expect(mutations.modified).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: modified file shows as modified', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'old')] });
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('new'));
    const mutations = cache.getMutations();
    expect(mutations.modified.map((m) => m.path)).toContain('/workspace/a.txt');
    expect(mutations.created).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: deleted file shows as deleted', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'x')] });
    cache.unlink('/workspace/a.txt');
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a.txt');
    expect(mutations.created).toEqual([]);
    expect(mutations.modified).toEqual([]);
  });

  it('getMutations: unmodified file not in any list', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a.txt', 'x')] });
    const mutations = cache.getMutations();
    expect(mutations.created).toEqual([]);
    expect(mutations.modified).toEqual([]);
    expect(mutations.deleted).toEqual([]);
  });

  it('getMutations: file replaced by directory emits delete + create', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a', 'x')] });
    cache.unlink('/workspace/a');
    cache.mkdir('/workspace/a', true);
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a');
    expect(mutations.created.map((c) => c.path)).toContain('/workspace/a');
    const created = mutations.created.find((c) => c.path === '/workspace/a');
    expect(created?.isDirectory).toBe(true);
  });

  it('getMutations: directory replaced by file emits delete + create', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace/a', '', true)] });
    cache.rm('/workspace/a', true);
    cache.writeFile('/workspace/a', new TextEncoder().encode('now a file'));
    const mutations = cache.getMutations();
    expect(mutations.deleted).toContain('/workspace/a');
    const created = mutations.created.find((c) => c.path === '/workspace/a');
    expect(created?.isDirectory).toBe(false);
    expect(textOf(created!.content)).toBe('now a file');
  });

  it('mkdtemp retries on collision with an already-existing path', () => {
    const cache = new SyncFsCache(emptySnapshot());
    // Pre-create the path the first mkdtemp attempt would generate so the
    // implementation is forced to retry with an incremented counter.
    cache.mkdir('/workspace/test-_000000', true);
    const dir = cache.mkdtemp('/workspace/test-');
    expect(dir).not.toBe('/workspace/test-_000000');
    expect(cache.exists(dir)).toBe(true);
  });

  it('exists/stat report truncated files, readFile throws ENOSYNC', () => {
    const cache = new SyncFsCache({
      entries: [
        {
          path: '/workspace/big.bin',
          content: new Uint8Array(0),
          isDirectory: false,
          truncated: true,
        },
      ],
    });
    expect(cache.exists('/workspace/big.bin')).toBe(true);
    const stat = cache.stat('/workspace/big.bin');
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(0);
    try {
      cache.readFile('/workspace/big.bin');
      throw new Error('expected readFile to throw');
    } catch (e: any) {
      expect(e.code).toBe('ENOSYNC');
    }
  });

  it('path normalization handles trailing slashes, .. segments', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/a/../b.txt', new TextEncoder().encode('v'));
    expect(cache.exists('/workspace/b.txt')).toBe(true);
    expect(cache.exists('/workspace/b.txt/')).toBe(true);

    cache.mkdir('/workspace/dir/');
    expect(cache.exists('/workspace/dir')).toBe(true);
  });
});

describe('SyncFsCache: exec-coherence support (wasUsed / applySnapshot / resetBaseline)', () => {
  it('wasUsed is false until a sync op runs, then stays true', () => {
    const cache = new SyncFsCache(emptySnapshot());
    expect(cache.wasUsed()).toBe(false);
    // A pure read counts as "used" — a later exec must re-snapshot for it.
    cache.exists('/workspace/nope.txt');
    expect(cache.wasUsed()).toBe(true);
  });

  it('every sync accessor marks the cache used (reads included)', () => {
    for (const touch of [
      (c: SyncFsCache) => c.exists('/x'),
      (c: SyncFsCache) => {
        try {
          c.readFile('/x');
        } catch {
          /* ENOENT still counts as a use */
        }
      },
      (c: SyncFsCache) => c.writeFile('/x', new Uint8Array()),
      (c: SyncFsCache) => c.mkdir('/d', true),
    ]) {
      const cache = new SyncFsCache(emptySnapshot());
      expect(cache.wasUsed()).toBe(false);
      touch(cache);
      expect(cache.wasUsed()).toBe(true);
    }
  });

  it('applySnapshot rebuilds the tree and resets the mutation baseline', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/workspace/old.txt', new TextEncoder().encode('old'));
    // A prior local write is a pending mutation…
    expect(cache.getMutations().created.map((c) => c.path)).toContain('/workspace/old.txt');

    // …until a host re-snapshot supersedes it: the new snapshot becomes the
    // baseline, so `old.txt` (absent from it) is gone and `new.txt` is present
    // yet NOT reported as a mutation.
    cache.applySnapshot({
      entries: [textEntry('/workspace', '', true), textEntry('/workspace/new.txt', 'fresh')],
    });
    expect(cache.exists('/workspace/old.txt')).toBe(false);
    expect(textOf(cache.readFile('/workspace/new.txt'))).toBe('fresh');
    const m = cache.getMutations();
    expect(m.created).toHaveLength(0);
    expect(m.modified).toHaveLength(0);
    expect(m.deleted).toHaveLength(0);
  });

  it('applySnapshot keeps wasUsed set (script stays on the coherent path)', () => {
    const cache = new SyncFsCache(emptySnapshot());
    cache.writeFile('/w/a.txt', new Uint8Array());
    expect(cache.wasUsed()).toBe(true);
    cache.applySnapshot(emptySnapshot());
    expect(cache.wasUsed()).toBe(true);
  });

  it('resetBaseline makes the current tree the new baseline (no re-flush)', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace', '', true)] });
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('AAA'));
    expect(cache.getMutations().created.map((c) => c.path)).toEqual(['/workspace/a.txt']);

    // After a mid-script flush, resetBaseline pins the current state so the
    // just-flushed write is not reported (and re-applied) again…
    cache.resetBaseline();
    expect(cache.getMutations().created).toHaveLength(0);

    // …while a NEW write after the reset is still reported.
    cache.writeFile('/workspace/b.txt', new TextEncoder().encode('BBB'));
    const m = cache.getMutations();
    expect(m.created.map((c) => c.path)).toEqual(['/workspace/b.txt']);
  });

  it('applySnapshotPreservingMutations keeps a local write absent from the snapshot', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace', '', true)] });
    // Simulate the exec.start window: a sync write the exec never saw and that
    // was never flushed (baseline still the pre-exec state).
    cache.writeFile('/workspace/later.txt', new TextEncoder().encode('LATER'));

    // The host re-snapshot doesn't contain later.txt (exec touched other paths).
    cache.applySnapshotPreservingMutations({
      entries: [textEntry('/workspace', '', true), textEntry('/workspace/from-exec.txt', 'X')],
    });

    // Both survive: the exec's write AND the preserved local write.
    expect(textOf(cache.readFile('/workspace/from-exec.txt'))).toBe('X');
    expect(textOf(cache.readFile('/workspace/later.txt'))).toBe('LATER');

    // And later.txt remains a mutation relative to the new baseline, so the
    // end-of-script flush still ships it; from-exec.txt (in the snapshot) does
    // not re-flush.
    const m = cache.getMutations();
    expect(m.created.map((c) => c.path)).toEqual(['/workspace/later.txt']);
    expect(m.modified).toHaveLength(0);
  });

  it('applySnapshotPreservingMutations: local write wins over an exec write to the same path', () => {
    const cache = new SyncFsCache({ entries: [textEntry('/workspace', '', true)] });
    cache.writeFile('/workspace/a.txt', new TextEncoder().encode('SYNC'));

    // The exec also wrote a.txt (present in the snapshot with different bytes).
    cache.applySnapshotPreservingMutations({
      entries: [textEntry('/workspace', '', true), textEntry('/workspace/a.txt', 'EXEC')],
    });

    // The later sync write wins for the path it touched.
    expect(textOf(cache.readFile('/workspace/a.txt'))).toBe('SYNC');
    // It reads back as a modification relative to the exec's baseline.
    const m = cache.getMutations();
    expect(m.modified.map((mm) => mm.path)).toEqual(['/workspace/a.txt']);
  });

  it('applySnapshotPreservingMutations: a local delete is not resurrected by the snapshot', () => {
    const cache = new SyncFsCache({
      entries: [textEntry('/workspace', '', true), textEntry('/workspace/gone.txt', 'v')],
    });
    // Baseline includes gone.txt; a sync unlink removes it in the window.
    cache.resetBaseline();
    cache.unlink('/workspace/gone.txt');

    // The host re-snapshot still has gone.txt (exec never deleted it).
    cache.applySnapshotPreservingMutations({
      entries: [textEntry('/workspace', '', true), textEntry('/workspace/gone.txt', 'v')],
    });

    // The local delete wins and is shipped as a deletion at end-of-script.
    expect(cache.exists('/workspace/gone.txt')).toBe(false);
    expect(cache.getMutations().deleted).toEqual(['/workspace/gone.txt']);
  });
});
