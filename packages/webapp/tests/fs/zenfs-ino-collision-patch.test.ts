import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the ino-collision patches (#2146).
//
// ZenFS keys its VFS vnode cache by `inode.ino`. `@zenfs/dom`'s WebAccess
// backend minted `ino: 0` inodes in two places (stat's ENOENT recovery and
// `_loadMetadata`'s reality branch), so a production index accumulated
// thousands of ino-0 entries — 2,858 of 14,763 on the live leader that filed
// the issue. Colliding entries collapse onto ONE shared vnode, and
// `VNode.sync()` then stamps that shared inode's size AND mode onto a single
// path: phantom directories (a file whose mode became its sibling
// directory's) and sibling-size truncation (a 26,623-byte file recorded at
// its sibling's 5,752).
//
// Two patches close it: @zenfs/dom allocates unique ino/data pairs at both
// minting sites, and @zenfs/core's VCache refuses to coalesce DIFFERENT
// paths onto one vnode unless they are a genuine hardlink (nonzero ino,
// matching format bits, nlink > 1 on both sides — #2034 added the nlink
// rule after a duplicated real ino made concurrent reads of two paths
// return the same bytes). These tests fail if either patch is missing or
// stops applying.
//
// Both halves are filed upstream. zen-fs/core#314 covers the VCache side, with
// a repro that needs neither patch to explain: ZenFS's own `make-index` copies
// host `st_ino` values and drops `st_dev`, so an index over a tree spanning two
// volumes carries duplicate inos, and the Fetch backend then serves one file's
// bytes for another. zen-fs/dom#43 covers the minting side, with a failing test
// against zen-fs/dom's own ponyfill suite: mounting a directory that already
// holds files gives every one of them ino 0.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('@zenfs/dom ino allocation patch (#2146)', () => {
  it('stat ENOENT recovery and the reality branch mint unique inos', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(
      src.includes('const inode = new Inode();'),
      'Installed @zenfs/dom still mints zeroed (ino: 0) inodes in stat()’s ' +
        'ENOENT recovery; patches/@zenfs+dom+*.patch is missing or failed to ' +
        'apply. Every recovered path then collides in the vnode cache and ' +
        'cross-stamps size/mode with unrelated files. See patches/README.md.'
    ).toBe(false);
    expect(src).toContain('const recoveredId = this.index._alloc();');
    expect(src).toContain('nextRealityId');
  });

  it('the #2146 allocations set nlink: 1 (nlink-0 warn flood, 2026-08-18 outage)', () => {
    // Every minted inode must carry a link count: ZenFS's Inode constructor
    // warns on `ino != 0 && nlink == 0`, kerium retains every log entry, and
    // a tree indexed through these sites re-warned on every inode
    // materialization until the log Set hit V8's 2^24 cap and every FS op
    // threw "Set maximum size exceeded" — the VFS-offline outage.
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(src).toContain('nlink: 1, mode: 0o644 | constants.S_IFREG');
    expect(src).toContain('nlink: 1, mode: 0o777 | constants.S_IFDIR');
    expect(src).toContain('data: recoveredId + 1, nlink: 1');
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

    // Two unrelated paths whose inodes both carry ino 0 (the poisoned-index
    // shape) must NOT share a vnode.
    const a = cache.ref('/a.txt', { ino: 0, mode: S_IFREG | 0o644, size: 100 });
    const b = cache.ref('/b.txt', { ino: 0, mode: S_IFREG | 0o644, size: 5 });
    expect(a).not.toBe(b);
    expect(a.inode.size).toBe(100);
    expect(b.inode.size).toBe(5);

    // Format-bit mismatch on a shared nonzero ino must not coalesce either —
    // that is the file↔directory phantom of #2146 findings 1/2.
    const f = cache.ref('/file', { ino: 7, mode: S_IFREG | 0o644, size: 10 });
    const d = cache.ref('/dir', { ino: 7, mode: S_IFDIR | 0o755, size: 0 });
    expect(f).not.toBe(d);

    // Genuine hardlinks — same real ino, same mode, nlink > 1 — still share
    // one vnode.
    const h1 = cache.ref('/link1', { ino: 9, mode: S_IFREG | 0o644, size: 42, nlink: 2 });
    const h2 = cache.ref('/link2', { ino: 9, mode: S_IFREG | 0o644, size: 42, nlink: 2 });
    expect(h1).toBe(h2);

    // A DUPLICATED real ino with nlink 1 is a poisoned index, not a hardlink
    // (#2034): the two paths must keep separate vnodes — and separate data
    // caches — or a concurrent read of one returns the other's bytes.
    const p = cache.ref('/dist/index.js', { ino: 11, mode: S_IFREG | 0o644, size: 50, nlink: 1 });
    const q = cache.ref('/dist/chunk-a.js', { ino: 11, mode: S_IFREG | 0o644, size: 70, nlink: 1 });
    expect(p).not.toBe(q);
    expect(p.inode.size).toBe(50);
    expect(q.inode.size).toBe(70);
    expect(
      cache.ref('/dist/index.js', { ino: 11, mode: S_IFREG | 0o644, size: 50, nlink: 1 })
    ).toBe(p);

    // Re-refing the SAME path with ino 0 joins its own vnode (no churn).
    const a2 = cache.ref('/a.txt', { ino: 0, mode: S_IFREG | 0o644, size: 100 });
    expect(a2).toBe(a);
  });
});
