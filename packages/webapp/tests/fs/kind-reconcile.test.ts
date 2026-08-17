import { describe, expect, it } from 'vitest';
import {
  findDirtyKindFlips,
  memoryKindOfMode,
  shouldReconcileKind,
} from '../../src/fs/kind-reconcile.js';

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;

describe('memoryKindOfMode', () => {
  it('classifies directory and file format bits, and absence', () => {
    expect(memoryKindOfMode(S_IFDIR | 0o755)).toBe('directory');
    expect(memoryKindOfMode(S_IFREG | 0o644)).toBe('file');
    expect(memoryKindOfMode(undefined)).toBe('absent');
  });
});

describe('shouldReconcileKind', () => {
  // The production incident: a genuine file held in memory as a directory.
  it('heals a memory directory over a real file (the #2006 incident)', () => {
    expect(shouldReconcileKind({ kind: 'file', size: 16249 }, 'directory')).toBe(true);
  });

  it('heals a memory file over a real directory', () => {
    expect(shouldReconcileKind({ kind: 'directory' }, 'file')).toBe(true);
  });

  it('heals a memory entry whose path is gone from OPFS', () => {
    expect(shouldReconcileKind({ kind: 'missing' }, 'file')).toBe(true);
    expect(shouldReconcileKind({ kind: 'missing' }, 'directory')).toBe(true);
  });

  // The guard that prevents retry loops: agreement means the error was
  // genuine (really reading a directory), so nothing is healed.
  it('refuses to heal when memory agrees with reality', () => {
    expect(shouldReconcileKind({ kind: 'directory' }, 'directory')).toBe(false);
    expect(shouldReconcileKind({ kind: 'file', size: 1 }, 'file')).toBe(false);
  });

  it('refuses to heal when memory holds nothing', () => {
    expect(shouldReconcileKind({ kind: 'file', size: 1 }, 'absent')).toBe(false);
    expect(shouldReconcileKind({ kind: 'missing' }, 'absent')).toBe(false);
  });
});

describe('findDirtyKindFlips', () => {
  const file = { mode: S_IFREG | 0o644 };
  const dir = { mode: S_IFDIR | 0o755 };

  it('finds a dirty path whose kind flipped between memory and disk', () => {
    const flips = findDirtyKindFlips(
      { entries: { '/workspace/CLAUDE.md': dir } },
      { entries: { '/workspace/CLAUDE.md': file } },
      new Set(['/workspace/CLAUDE.md'])
    );
    expect(flips).toEqual([{ path: '/workspace/CLAUDE.md', ownIsDirectory: true }]);
  });

  it('ignores same-kind dirty paths, adds, and deletes', () => {
    const flips = findDirtyKindFlips(
      { entries: { '/a': file, '/added': file } },
      { entries: { '/a': file, '/deleted': file } },
      new Set(['/a', '/added', '/deleted'])
    );
    expect(flips).toEqual([]);
  });

  // Review catch on #2135: a rename marks subtrees in dirty.prefixes, and the
  // merge overlays every own entry beneath them — entries dirty.paths never
  // names. The audit must see those too.
  it('finds flips under dirty prefixes, not just explicit dirty paths', () => {
    const flips = findDirtyKindFlips(
      { entries: { '/renamed/child.md': dir, '/renamed/ok.md': file } },
      { entries: { '/renamed/child.md': file, '/renamed/ok.md': file } },
      new Set(),
      new Set(['/renamed'])
    );
    expect(flips).toEqual([{ path: '/renamed/child.md', ownIsDirectory: true }]);
  });

  it('a prefix matches its own path and children, not lookalike siblings', () => {
    const flips = findDirtyKindFlips(
      { entries: { '/pre': dir, '/prefix-lookalike': dir } },
      { entries: { '/pre': file, '/prefix-lookalike': file } },
      new Set(),
      new Set(['/pre'])
    );
    expect(flips.map((f) => f.path)).toEqual(['/pre']);
  });

  it('only considers dirty paths, never the whole index', () => {
    const flips = findDirtyKindFlips(
      { entries: { '/clean-flip': dir, '/dirty-flip': dir } },
      { entries: { '/clean-flip': file, '/dirty-flip': file } },
      new Set(['/dirty-flip'])
    );
    expect(flips.map((f) => f.path)).toEqual(['/dirty-flip']);
  });
});
