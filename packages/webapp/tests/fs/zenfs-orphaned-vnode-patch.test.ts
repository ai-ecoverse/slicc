/**
 * #4097: `ipk add -g` left a package.json that was all NUL bytes.
 *
 * Every ZenFS read marks its vnode's metadata dirty (atime), and closing the
 * handle flushes the vnode's inode through `WebAccessFS.touch`, which sets
 * the OPFS file's length to the inode's size. A read still open when its path
 * is removed and written again flushed the OLD inode onto the NEW file: a
 * shorter old file truncated it, a longer one padded it with NUL bytes, and a
 * flush landing between the new file's creation and its data left nothing but
 * NULs. The patch in `patches/@zenfs+core+2.7.7.patch` drops a vnode's pending
 * changes once no path names it (unlinked, or replaced by a rename).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VNode } from '@zenfs/core/vfs/vnode.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  createGatedDirectoryHandle,
  createMutableDirectoryHandle,
  type GatedFileOp,
  type HeldFileOp,
} from './fsa-test-helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DIR = '/shared/lib/node_modules/brace-expansion';
const MANIFEST = `${DIR}/package.json`;

describe('@zenfs/core orphaned-vnode patch (#4097)', () => {
  it('the installed dist carries the patch', () => {
    const dist = (file: string) =>
      readFileSync(resolve(repoRoot, `node_modules/@zenfs/core/dist/vfs/${file}`), 'utf8');
    expect(dist('vnode.js')).toContain('_dropIfOrphaned()');
    expect(dist('vcache.js')).toContain('replaced.paths.delete(newPath)');
  });
});

describe('VNode.sync on a vnode orphaned mid-flush', () => {
  it('stops before its next backend call', async () => {
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const calls: string[] = [];
    const backend = {
      attributes: new Map(),
      write: async (path: string) => {
        calls.push(`write ${path}`);
        await writeHeld;
      },
      touch: async (path: string) => {
        calls.push(`touch ${path}`);
      },
    };
    const inode = { ino: 7, size: 0, mode: 0o100644, flags: 0, mtimeMs: 0, ctimeMs: 0 };
    const node = new VNode(backend as never, '/f', inode as never);
    await node.write(new Uint8Array([1, 2, 3]), 0);

    const syncing = node.sync();
    await Promise.resolve();
    node.paths.delete('/f'); // what VCache.remove does on unlink
    releaseWrite();
    await syncing;

    // Unpatched mid-flush: the trailing touch stamped size 3 onto '/f'.
    expect(calls).toEqual(['write /f']);
    expect(node.dirty).toBe(false);
  });
});

let dbCounter = 0;

describe('a read open across a rewrite of its path', () => {
  let fs: VirtualFS;
  let hold: (op: GatedFileOp, path: string) => HeldFileOp;
  let dbName: string;

  beforeEach(async () => {
    const gated = createGatedDirectoryHandle(createMutableDirectoryHandle({}).handle);
    hold = (op, path) => gated.hold(op, `${dbName}${path}`);
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => gated.handle } });
    dbName = `orphaned-vnode-${dbCounter++}`;
    fs = await VirtualFS.create({ dbName, backend: 'opfs', wipe: true });
  });

  afterEach(async () => {
    await fs.dispose();
    vi.unstubAllGlobals();
  });

  /** Start a read of `path` and hold it inside ZenFS, its file handle open, until `release()`. */
  async function holdRead(path: string): Promise<{ done: Promise<unknown>; release(): void }> {
    const held = hold('getFile', path);
    const done = fs.readFile(path);
    await held.reached;
    return { done, release: held.release };
  }

  for (const [label, length] of [
    ['shorter', 100],
    ['as long as', 300],
    ['longer', 500],
  ] as const) {
    it(`leaves a rewrite ${label} the old file intact`, async () => {
      await fs.writeFile(MANIFEST, 'A'.repeat(300));
      const reading = await holdRead(MANIFEST);

      await fs.rm(DIR, { recursive: true });
      const next = 'B'.repeat(length);
      await fs.writeFile(MANIFEST, next);
      reading.release();
      await reading.done;

      // Unpatched: 300 bytes, either cut short or padded with NULs.
      expect(await fs.readFile(MANIFEST)).toBe(next);
    });
  }

  it('leaves a same-size rewrite intact when the stale flush lands mid-write', async () => {
    // The CI case: the same version installed again, so the new manifest is
    // exactly as long as the old one, and the read's flush races the write.
    // The read checks the size while the new file is still empty, pads it to
    // the old length, and commits after the data did: all NUL bytes.
    await fs.writeFile(MANIFEST, 'A'.repeat(300));
    const reading = await holdRead(MANIFEST);
    const dataWrite = hold('createWritable', MANIFEST);
    const writing = (async () => {
      await fs.rm(DIR, { recursive: true });
      await fs.writeFile(MANIFEST, 'B'.repeat(300));
    })();
    await dataWrite.reached;

    const staleFlush = hold('close', MANIFEST);
    reading.release();
    const flushed = await Promise.race([
      staleFlush.reached.then(() => true),
      reading.done.then(() => false),
    ]);
    // Unflushed, the gate is still armed and would hold the writer's own commit.
    if (!flushed) staleFlush.release();
    dataWrite.release();
    await writing;
    staleFlush.release();
    await reading.done;

    // Unpatched: 300 NUL bytes.
    expect(await fs.readFile(MANIFEST)).toBe('B'.repeat(300));
    expect(flushed).toBe(false);
  });

  it('leaves a file renamed over the read path intact', async () => {
    await fs.writeFile(MANIFEST, 'A'.repeat(300));
    await fs.writeFile(`${DIR}/package.json.tmp`, 'C'.repeat(120));
    const reading = await holdRead(MANIFEST);

    await fs.rename(`${DIR}/package.json.tmp`, MANIFEST);
    reading.release();
    await reading.done;

    expect(await fs.readFile(MANIFEST)).toBe('C'.repeat(120));
  });
});
