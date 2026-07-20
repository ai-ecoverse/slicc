import { describe, expect, it } from 'vitest';
import {
  MAX_SYMLINK_DEPTH,
  realpath,
  resolveSymlinks,
  type SymlinkLfs,
} from '../../src/fs/symlink-resolver.js';
import type { FsStatsLike } from '../../src/fs/types.js';

function statFor(kind: 'file' | 'dir' | 'link'): FsStatsLike {
  return {
    size: 0,
    mode: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  };
}

function fakeLfs(links: Record<string, string>, files: Set<string>): SymlinkLfs {
  // Any path that is a proper ancestor of a known file or link is a directory
  // (mirrors a real tree where intermediate components must exist to be walked).
  const isAncestorDir = (p: string) =>
    [...Array.from(files), ...Object.keys(links)].some((entry) => entry.startsWith(`${p}/`));
  return {
    async lstat(p: string) {
      if (p in links) return statFor('link');
      if (files.has(p)) return statFor('file');
      if (isAncestorDir(p)) return statFor('dir');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readlink(p: string) {
      if (p in links) return links[p] as string;
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    },
  };
}

const noMount = () => false;

describe('symlink-resolver.realpath', () => {
  it('follows a tail symlink to its target', async () => {
    const lfs = fakeLfs({ '/link.txt': '/real.txt' }, new Set(['/real.txt']));
    expect(await realpath(lfs, noMount, '/link.txt')).toBe('/real.txt');
  });

  it('resolves a relative symlink target against the link directory', async () => {
    const lfs = fakeLfs({ '/dir/link': 'target.txt' }, new Set(['/dir/target.txt']));
    expect(await realpath(lfs, noMount, '/dir/link')).toBe('/dir/target.txt');
  });

  it('resolves an intermediate directory-component symlink', async () => {
    const lfs = fakeLfs({ '/alias': '/real' }, new Set(['/real/file.txt']));
    expect(await realpath(lfs, noMount, '/alias/file.txt')).toBe('/real/file.txt');
  });

  it('tolerates ENOENT on the tail component (returns canonical path)', async () => {
    const lfs = fakeLfs({}, new Set());
    expect(await realpath(lfs, noMount, '/missing.txt')).toBe('/missing.txt');
  });

  it('throws ELOOP past the hop cap', async () => {
    const lfs = fakeLfs({ '/a': '/b', '/b': '/a' }, new Set());
    await expect(realpath(lfs, noMount, '/a')).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('returns mount paths unchanged (already real)', async () => {
    const lfs = fakeLfs({}, new Set());
    expect(await realpath(lfs, () => true, '/mnt/repo/pack')).toBe('/mnt/repo/pack');
  });

  it('has a documented hop cap of 10', () => {
    expect(MAX_SYMLINK_DEPTH).toBe(10);
  });
});

describe('symlink-resolver.resolveSymlinks', () => {
  it('returns mount paths unchanged without touching the backend', async () => {
    const lfs = fakeLfs({}, new Set());
    expect(await resolveSymlinks(lfs, () => true, '/mnt/x/y')).toBe('/mnt/x/y');
  });

  it('resolves symlinks for non-mount paths', async () => {
    const lfs = fakeLfs({ '/link': '/real' }, new Set(['/real']));
    expect(await resolveSymlinks(lfs, noMount, '/link')).toBe('/real');
  });
});
