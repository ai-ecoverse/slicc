import { describe, it, expect } from 'vitest';
import { computeRsyncDiff, type RsyncEntry } from './rsync-diff.js';

describe('computeRsyncDiff', () => {
  it('returns empty result for two empty lists', () => {
    const result = computeRsyncDiff([], []);
    expect(result).toEqual({ toAdd: [], toUpdate: [], toDelete: [], toSkip: [] });
  });

  it('marks all source files as toAdd when dest is empty', () => {
    const source: RsyncEntry[] = [
      { path: 'a.txt', size: 10, mtimeMs: 1000 },
      { path: 'b.txt', size: 20, mtimeMs: 2000 },
    ];
    const result = computeRsyncDiff(source, []);
    expect(result.toAdd).toEqual(['a.txt', 'b.txt']);
    expect(result.toUpdate).toEqual([]);
    expect(result.toDelete).toEqual([]);
    expect(result.toSkip).toEqual([]);
  });

  it('marks all dest files as toDelete when source is empty and --delete is set', () => {
    const dest: RsyncEntry[] = [{ path: 'old.txt', size: 5, mtimeMs: 500 }];
    const result = computeRsyncDiff([], dest, { delete: true });
    expect(result.toDelete).toEqual(['old.txt']);
    expect(result.toAdd).toEqual([]);
  });

  it('does not delete dest files when --delete is not set', () => {
    const dest: RsyncEntry[] = [{ path: 'old.txt', size: 5, mtimeMs: 500 }];
    const result = computeRsyncDiff([], dest);
    expect(result.toDelete).toEqual([]);
  });

  it('skips files with same size and mtime', () => {
    const entries: RsyncEntry[] = [{ path: 'same.txt', size: 100, mtimeMs: 3000 }];
    const result = computeRsyncDiff(entries, entries);
    expect(result.toSkip).toEqual(['same.txt']);
    expect(result.toAdd).toEqual([]);
    expect(result.toUpdate).toEqual([]);
  });

  it('marks files for update when size differs', () => {
    const source: RsyncEntry[] = [{ path: 'file.txt', size: 200, mtimeMs: 3000 }];
    const dest: RsyncEntry[] = [{ path: 'file.txt', size: 100, mtimeMs: 3000 }];
    const result = computeRsyncDiff(source, dest);
    expect(result.toUpdate).toEqual(['file.txt']);
    expect(result.toSkip).toEqual([]);
  });

  it('marks files for update when mtime differs', () => {
    const source: RsyncEntry[] = [{ path: 'file.txt', size: 100, mtimeMs: 5000 }];
    const dest: RsyncEntry[] = [{ path: 'file.txt', size: 100, mtimeMs: 3000 }];
    const result = computeRsyncDiff(source, dest);
    expect(result.toUpdate).toEqual(['file.txt']);
  });

  it('handles a mix of add, update, skip, and delete', () => {
    const source: RsyncEntry[] = [
      { path: 'new.txt', size: 10, mtimeMs: 1000 },
      { path: 'changed.txt', size: 50, mtimeMs: 2000 },
      { path: 'same.txt', size: 30, mtimeMs: 3000 },
    ];
    const dest: RsyncEntry[] = [
      { path: 'changed.txt', size: 40, mtimeMs: 1500 },
      { path: 'same.txt', size: 30, mtimeMs: 3000 },
      { path: 'removed.txt', size: 5, mtimeMs: 100 },
    ];

    const result = computeRsyncDiff(source, dest, { delete: true });
    expect(result.toAdd).toEqual(['new.txt']);
    expect(result.toUpdate).toEqual(['changed.txt']);
    expect(result.toSkip).toEqual(['same.txt']);
    expect(result.toDelete).toEqual(['removed.txt']);
  });

  it('handles nested paths', () => {
    const source: RsyncEntry[] = [{ path: 'dir/sub/file.txt', size: 10, mtimeMs: 1000 }];
    const result = computeRsyncDiff(source, []);
    expect(result.toAdd).toEqual(['dir/sub/file.txt']);
  });
});
