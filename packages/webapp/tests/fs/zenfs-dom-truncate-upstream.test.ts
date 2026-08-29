/**
 * Regression guard for the OPFS shrink-tail leak — now an UPSTREAM pin.
 *
 * `@zenfs/dom`'s WebAccess backend opened every write with
 * `createWritable({ keepExistingData: true })` and never truncated the handle,
 * because `IndexFS.touch` only narrows the in-memory inode. Two consequences:
 *
 *   - Latency: Chromium copies the entire existing file into the swap file
 *     before the first byte is written, so a write cost O(file size) even when
 *     it replaced the whole file (a 92 MB rewrite measured 480 ms, 240 ms
 *     without the copy).
 *   - Quota, the worse one: the tail of a shrunk file survived on disk forever.
 *     Rewriting a 92 MB file as 4 MB left 92 MB on disk — 88 MB of OPFS quota
 *     that no later write could reclaim, on a filesystem whose failures under
 *     pressure are exactly what #1979 tracks.
 *
 * We carried a local hunk in `patches/@zenfs+dom+<ver>.patch` that skipped the
 * copy for writes spanning the whole file (`keepExistingData: !fullWrite`).
 * The real fix landed upstream in 1.2.11 (zen-fs/dom#42): `WebAccessFS.touch`
 * now truncates the backing handle. That also removes the latency half, because
 * `Vnode.sync` pre-truncates before flushing dirty ranges (`needsPreTruncate`),
 * so an O_TRUNC rewrite reaches `write` with a 0-byte file on disk and
 * `keepExistingData: true` copies nothing. The patch hunk is gone; this suite
 * stays as the pin, so a downgrade or an upstream regression that drops the
 * truncate fails here rather than in a user's OPFS quota.
 * Upstream fix: https://github.com/zen-fs/dom/issues/42
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { createMutableDirectoryHandle, type MutableDirectoryHandle } from './fsa-test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('@zenfs/dom shrink-truncate fix (zen-fs/dom#42)', () => {
  it('the installed dist truncates the handle in touch', () => {
    const src = readFileSync(resolve(repoRoot, 'node_modules/@zenfs/dom/dist/access.js'), 'utf8');
    expect(
      src.includes('async touch(path, metadata)'),
      'Installed @zenfs/dom no longer overrides `touch` in WebAccessFS — the ' +
        'zen-fs/dom#42 fix shipped in 1.2.11, so this means a downgrade or an ' +
        'upstream regression. Shrinking a file then leaves its tail on disk ' +
        'forever, unreclaimable OPFS quota. See patches/README.md.'
    ).toBe(true);
    expect(src).toContain('writable.truncate(metadata.size)');
  });
});

// Same dbName means the same resolved WebAccessFS (and index), so each case
// needs its own — see tests/fs/zero-byte-file-delete.test.ts.
let dbCounter = 0;

describe('shrinking a file on the OPFS backend reclaims its tail', () => {
  let opfs: MutableDirectoryHandle;
  let dbName: string;
  let fs: VirtualFS;

  beforeEach(async () => {
    opfs = createMutableDirectoryHandle({});
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async (): Promise<FileSystemDirectoryHandle> => opfs.handle },
    });
    dbName = `shrink-truncate-${dbCounter++}`;
    fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
    await fs.mkdir('/workspace/shrink', { recursive: true });
  });

  afterEach(async () => {
    await fs.dispose();
    vi.unstubAllGlobals();
  });

  /**
   * Size of the file in the REAL backing store, read through the mock handle
   * rather than the VFS. The whole defect was that the two disagreed: the inode
   * said 4 bytes and OPFS still held the original 92.
   */
  async function backingSize(vfsPath: string): Promise<number> {
    const segments = vfsPath.split('/').filter(Boolean);
    let dir = await opfs.handle.getDirectoryHandle(dbName);
    for (const segment of segments.slice(0, -1)) dir = await dir.getDirectoryHandle(segment);
    const handle = await dir.getFileHandle(segments[segments.length - 1]);
    return (await handle.getFile()).size;
  }

  it('a smaller rewrite leaves no bytes of the larger original behind', async () => {
    const big = 'A'.repeat(9_200);
    await fs.writeFile('/workspace/shrink/f.txt', big);
    expect(await backingSize('/workspace/shrink/f.txt')).toBe(big.length);

    await fs.writeFile('/workspace/shrink/f.txt', 'tiny');
    expect(await fs.readTextFile('/workspace/shrink/f.txt')).toBe('tiny');
    // Pre-1.2.11 this was still 9_200: the inode narrowed, the handle did not.
    expect(await backingSize('/workspace/shrink/f.txt')).toBe(4);
  });

  it('a larger rewrite still keeps every byte (control)', async () => {
    await fs.writeFile('/workspace/shrink/g.txt', 'tiny');
    const grown = 'B'.repeat(5_000);
    await fs.writeFile('/workspace/shrink/g.txt', grown);
    expect(await fs.readTextFile('/workspace/shrink/g.txt')).toBe(grown);
    expect(await backingSize('/workspace/shrink/g.txt')).toBe(grown.length);
  });

  it('survives a shrink/grow round trip without stale bytes', async () => {
    // A truncate that leaves the handle in a bad state would show up on the
    // way back up: the regrown file must be exactly the new content, not the
    // new content laid over what the shrink was supposed to have removed.
    await fs.writeFile('/workspace/shrink/h.txt', 'Z'.repeat(7_000));
    await fs.writeFile('/workspace/shrink/h.txt', 'ab');
    const regrown = 'C'.repeat(3_000);
    await fs.writeFile('/workspace/shrink/h.txt', regrown);
    expect(await fs.readTextFile('/workspace/shrink/h.txt')).toBe(regrown);
    expect(await backingSize('/workspace/shrink/h.txt')).toBe(regrown.length);
  });
});
