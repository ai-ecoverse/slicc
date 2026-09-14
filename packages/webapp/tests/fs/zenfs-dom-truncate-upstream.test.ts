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
    await fs.writeFile('/workspace/shrink/h.txt', 'Z'.repeat(7_000));
    await fs.writeFile('/workspace/shrink/h.txt', 'ab');
    const regrown = 'C'.repeat(3_000);
    await fs.writeFile('/workspace/shrink/h.txt', regrown);
    expect(await fs.readTextFile('/workspace/shrink/h.txt')).toBe(regrown);
    expect(await backingSize('/workspace/shrink/h.txt')).toBe(regrown.length);
  });
});
