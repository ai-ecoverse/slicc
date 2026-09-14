import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('@zenfs/dom ino allocation (zen-fs/dom#43, shipped in 1.2.12)', () => {
  it('stat ENOENT recovery and the reality branch mint unique inos', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(
      src.includes('const inode = new Inode();'),
      'Installed @zenfs/dom still mints zeroed (ino: 0) inodes in stat()’s ' +
        'ENOENT recovery; 1.2.12 (zen-fs/dom#43) allocates real ino/data at ' +
        'both minting sites, so this means a downgrade or an upstream ' +
        'regression. Every recovered path then collides in the vnode cache ' +
        'and cross-stamps size/mode with unrelated files. See patches/README.md.'
    ).toBe(false);
    expect(src).toContain('const ino = this.index._alloc();');
    expect(src).toContain('data: ino + 1');
  });

  it('the remaining #2146 allocations set nlink: 1 (nlink-0 warn flood, 2026-08-18 outage)', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(src).toContain(
      'mode: 0o644 | constants.S_IFREG, size, mtimeMs: lastModified, ino, data: ino + 1, nlink: 1'
    );
    expect(src).toContain('mode: 0o777 | constants.S_IFDIR, size: 0, ino, data: ino + 1, nlink: 1');
    expect(src).toContain('new Inode({ ino, data: ino + 1, nlink: 1 })');
  });
});

describe('@zenfs/core vnode-cache coalescing guard (#2146)', () => {
  const vcachePath = resolve(repoRoot, 'node_modules/@zenfs/core/dist/vfs/vcache.js');

  it('the guard is present in the installed dist', () => {
    const src = readFileSync(vcachePath, 'utf8');
    expect(
      src.includes('PATCH(#2146, #2034)'),
      'Installed @zenfs/core VCache.ref still coalesces different paths onto ' +
        'one vnode for ino-0/format-mismatched inodes; ' +
        'patches/@zenfs+core+*.patch is missing or failed to apply. ' +
        'See patches/README.md.'
    ).toBe(true);
  });

  it('behaviorally: two ino-0 paths get DISTINCT vnodes; hardlinks still share', async () => {
    const { VCache } = await import(
      /* @vite-ignore */ resolve(repoRoot, 'node_modules/@zenfs/core/dist/vfs/vcache.js')
    );
    const S_IFREG = 0o100000;
    const S_IFDIR = 0o40000;
    const fakeFs = { uuid: 'test', attributes: new Map() };
    const cache = new VCache(fakeFs);

    const a = cache.ref('/a.txt', { ino: 0, mode: S_IFREG | 0o644, size: 100 });
    const b = cache.ref('/b.txt', { ino: 0, mode: S_IFREG | 0o644, size: 5 });
    expect(a).not.toBe(b);
    expect(a.inode.size).toBe(100);
    expect(b.inode.size).toBe(5);

    const f = cache.ref('/file', { ino: 7, mode: S_IFREG | 0o644, size: 10 });
    const d = cache.ref('/dir', { ino: 7, mode: S_IFDIR | 0o755, size: 0 });
    expect(f).not.toBe(d);

    const h1 = cache.ref('/link1', { ino: 9, mode: S_IFREG | 0o644, size: 42, nlink: 2 });
    const h2 = cache.ref('/link2', { ino: 9, mode: S_IFREG | 0o644, size: 42, nlink: 2 });
    expect(h1).toBe(h2);

    const p = cache.ref('/dist/index.js', { ino: 11, mode: S_IFREG | 0o644, size: 50, nlink: 1 });
    const q = cache.ref('/dist/chunk-a.js', { ino: 11, mode: S_IFREG | 0o644, size: 70, nlink: 1 });
    expect(p).not.toBe(q);
    expect(p.inode.size).toBe(50);
    expect(q.inode.size).toBe(70);
    expect(
      cache.ref('/dist/index.js', { ino: 11, mode: S_IFREG | 0o644, size: 50, nlink: 1 })
    ).toBe(p);

    const a2 = cache.ref('/a.txt', { ino: 0, mode: S_IFREG | 0o644, size: 100 });
    expect(a2).toBe(a);
  });
});
