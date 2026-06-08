/**
 * Unit tests for `computePyodideMountDirs` — the top-level VFS
 * enumeration helper that picks which dirs `python` / `python3`
 * mount into the Pyodide realm. The realm-side mount mechanics are
 * covered by `tests/kernel/realm/py-realm-mount-opfs.test.ts`; this
 * file just pins the enumeration contract used to build the mount
 * list before it leaves the kernel-worker shell.
 */

import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import {
  computeOverlappingMountPoints,
  computePyodideMountDirs,
  DEFAULT_REMOTE_MOUNT_CAP,
  extractRemoteMountCap,
  parseHumanSize,
} from '../../../src/shell/supplemental-commands/python-command.js';

function makeFs(
  entries: Array<{ name: string; isDir?: boolean; statThrows?: boolean }>,
  opts: { readdirThrows?: boolean } = {}
): IFileSystem {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const fs: Partial<IFileSystem> = {
    readdir: vi.fn().mockImplementation(async (p: string) => {
      if (opts.readdirThrows) throw new Error('ENOENT');
      if (p !== '/') return [];
      return entries.map((e) => e.name);
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      const name = p.startsWith('/') ? p.slice(1) : p;
      const entry = byName.get(name);
      if (!entry || entry.statThrows) throw new Error(`ENOENT: ${p}`);
      return { isFile: !entry.isDir, isDirectory: !!entry.isDir, size: 0 };
    }),
  };
  return fs as IFileSystem;
}

describe('computePyodideMountDirs', () => {
  it('enumerates top-level VFS directories as absolute paths', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'shared', isDir: true },
      { name: 'scoops', isDir: true },
      { name: 'sessions', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/scoops', '/sessions', '/tmp']);
  });

  it('skips files at the VFS root', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'README.md', isDir: false },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('excludes Pyodide/Emscripten built-in names', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'dev', isDir: true },
      { name: 'proc', isDir: true },
      { name: 'lib', isDir: true },
      { name: 'bin', isDir: true },
      { name: 'usr', isDir: true },
      { name: 'etc', isDir: true },
      { name: 'home', isDir: true },
      { name: 'tmp', isDir: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('always appends /tmp even when the VFS root has no /tmp dir', async () => {
    const fs = makeFs([{ name: 'workspace', isDir: true }]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toContain('/tmp');
    // /tmp should appear exactly once and at the tail.
    expect(dirs.filter((d) => d === '/tmp')).toHaveLength(1);
    expect(dirs[dirs.length - 1]).toBe('/tmp');
  });

  it('skips entries whose stat() throws (dangling/unreadable)', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'broken', isDir: true, statThrows: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('falls back to [/tmp] when readdir(/) fails', async () => {
    const fs = makeFs([], { readdirThrows: true });
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/tmp']);
  });

  it('does not include "/" when invoked with a cwd of "/"', async () => {
    // The legacy code was `const syncDirs = [ctx.cwd, '/tmp']`; from
    // cwd '/' that collapsed to ['/', '/tmp'] and Emscripten rejected
    // the root mount with EBUSY. The new helper ignores cwd entirely
    // and emits absolute top-level dirs, so '/' must never appear.
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'shared', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).not.toContain('/');
    expect(dirs).toEqual(['/workspace', '/shared', '/tmp']);
  });

  it('deduplicates and ignores names containing a slash', async () => {
    const fs = makeFs([
      { name: 'workspace', isDir: true },
      { name: 'workspace', isDir: true },
      { name: 'a/b', isDir: true },
    ]);
    const dirs = await computePyodideMountDirs(fs);
    expect(dirs).toEqual(['/workspace', '/tmp']);
  });
});

describe('parseHumanSize', () => {
  it('handles bare integers as bytes', () => {
    expect(parseHumanSize('0')).toBe(0);
    expect(parseHumanSize('1024')).toBe(1024);
  });
  it('handles k/m/g (and kb/mb/gb) suffixes case-insensitively', () => {
    expect(parseHumanSize('5m')).toBe(5 * 1024 * 1024);
    expect(parseHumanSize('512K')).toBe(512 * 1024);
    expect(parseHumanSize('1g')).toBe(1024 ** 3);
    expect(parseHumanSize('2MB')).toBe(2 * 1024 * 1024);
    expect(parseHumanSize('1.5m')).toBe(Math.floor(1.5 * 1024 * 1024));
  });
  it('throws on invalid input', () => {
    expect(() => parseHumanSize('abc')).toThrow();
    expect(() => parseHumanSize('-1')).toThrow();
    expect(() => parseHumanSize('5x')).toThrow();
  });
});

describe('extractRemoteMountCap', () => {
  it('returns the default 5m when the flag is absent', () => {
    const r = extractRemoteMountCap(['-c', 'print(1)']);
    expect(r.remaining).toEqual(['-c', 'print(1)']);
    expect(r.remoteMountCapBytes).toBe(parseHumanSize(DEFAULT_REMOTE_MOUNT_CAP));
  });
  it('parses --remote-mount-cap=<size> and removes it from argv', () => {
    const r = extractRemoteMountCap(['--remote-mount-cap=10m', '-c', 'pass']);
    expect(r.remaining).toEqual(['-c', 'pass']);
    expect(r.remoteMountCapBytes).toBe(10 * 1024 * 1024);
  });
  it('parses two-token --remote-mount-cap <size>', () => {
    const r = extractRemoteMountCap(['--remote-mount-cap', '0', 'script.py']);
    expect(r.remaining).toEqual(['script.py']);
    expect(r.remoteMountCapBytes).toBe(0);
  });
  it('throws when the two-token form is missing its argument', () => {
    expect(() => extractRemoteMountCap(['--remote-mount-cap'])).toThrow();
  });
});

describe('computeOverlappingMountPoints', () => {
  function fsWithMounts(mounts: { path: string; kind: 'local' | 's3' | 'da' | 'proc' }[]) {
    return { listMountPoints: () => mounts } as unknown as IFileSystem;
  }
  it('returns [] when the FS does not expose listMountPoints (test stub)', () => {
    expect(computeOverlappingMountPoints({} as IFileSystem, ['/workspace'])).toEqual([]);
  });
  it('tags each overlapping mount with its kind, drops internal proc mounts', () => {
    const fs = fsWithMounts([
      { path: '/mnt/myapp', kind: 'local' },
      { path: '/mnt/s3', kind: 's3' },
      { path: '/workspace/repo', kind: 'da' },
      { path: '/proc', kind: 'proc' },
    ]);
    const out = computeOverlappingMountPoints(fs, ['/workspace', '/mnt', '/tmp']);
    expect(out).toEqual([
      { path: '/mnt/myapp', kind: 'local' },
      { path: '/mnt/s3', kind: 's3' },
      { path: '/workspace/repo', kind: 'da' },
    ]);
  });
  it('drops mounts that do not overlap any sync dir', () => {
    const fs = fsWithMounts([
      { path: '/somewhere-else', kind: 's3' },
      { path: '/workspace/x', kind: 'local' },
    ]);
    const out = computeOverlappingMountPoints(fs, ['/workspace']);
    expect(out).toEqual([{ path: '/workspace/x', kind: 'local' }]);
  });
});
