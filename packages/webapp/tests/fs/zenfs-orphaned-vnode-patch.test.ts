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
    node.paths.delete('/f');
    releaseWrite();
    await syncing;

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

      expect(await fs.readFile(MANIFEST)).toBe(next);
    });
  }

  it('leaves a same-size rewrite intact when the stale flush lands mid-write', async () => {
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

    if (!flushed) staleFlush.release();
    dataWrite.release();
    await writing;
    staleFlush.release();
    await reading.done;

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
