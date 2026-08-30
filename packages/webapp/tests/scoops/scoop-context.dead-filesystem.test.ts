/**
 * What a unit says when its filesystem is gone.
 *
 * `ensureDirectoryStructure` swallows every `mkdir` error by design (a
 * directory that already exists is the common case), so when the backing
 * store disappears the FIRST error anyone sees is the default-memory write.
 * Live, that turned a whole-VFS outage into `Failed to initialize: ENOENT …
 * /cones/cone-landlording/CLAUDE.md` — a cone-shaped message for a
 * float-wide fault, with a `Try again` button that could never work.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { ensureDirectoryStructure } from '../../src/scoops/scoop-context/directory-structure.js';
import { ScoopContext, type ScoopContextCallbacks } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { tmpDirFor } from '../../src/work-unit/descriptor.js';

let dbCounter = 0;
const open: VirtualFS[] = [];

async function makeFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `dead-fs-${dbCounter++}`, wipe: true });
  open.push(fs);
  return fs;
}

afterEach(async () => {
  for (const fs of open.splice(0)) await fs.dispose?.();
});

function coneRecord(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

function callbacks(): ScoopContextCallbacks {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as never),
  };
}

function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(
    new Error(`${code}: no such file or directory, undefined '/__opfs__/slicc-fs${path}'`),
    { code }
  );
}

/**
 * The live failure shape: the OPFS tree behind the mount is gone, so every
 * call fails and nothing exists.
 */
function deadFilesystem(): VirtualFS {
  return {
    mkdir: vi.fn(async (path: string) => {
      throw fsError('ENOENT', path);
    }),
    readFile: vi.fn(async (path: string) => {
      throw fsError('ENOENT', path);
    }),
    writeFile: vi.fn(async (path: string) => {
      throw fsError('ENOENT', path);
    }),
    exists: vi.fn(async () => false),
  } as unknown as VirtualFS;
}

/** Seed the skeleton of `ctx`'s unit against an arbitrary filesystem. */
function seedDirs(ctx: ScoopContext, fs: VirtualFS): Promise<void> {
  const inner = ctx as unknown as { scoop: RegisteredScoop; unit: never };
  return ensureDirectoryStructure(
    fs,
    inner.scoop,
    inner.unit,
    tmpDirFor([inner.scoop], inner.scoop)
  );
}

describe('directory seeding on a broken filesystem', () => {
  it('names the filesystem, not the memory file, when the workspace root is gone', async () => {
    const ctx = new ScoopContext(
      coneRecord({ jid: 'cone_2', name: 'Beta', folder: 'cone-beta', assistantLabel: 'Beta' }),
      callbacks(),
      await makeFs()
    );

    await expect(seedDirs(ctx, deadFilesystem())).rejects.toThrow(
      /workspace filesystem unavailable: \/cones\/cone-beta\/workspace is missing/
    );
  });

  it('keeps the underlying error as the cause and tells the user what to do', async () => {
    const ctx = new ScoopContext(coneRecord(), callbacks(), await makeFs());

    const err = await seedDirs(ctx, deadFilesystem()).then(
      () => {
        throw new Error('expected the dead filesystem to reject');
      },
      (e: unknown) => e as Error
    );

    expect(err.message).toContain('(ENOENT)');
    expect(err.message).toContain('reload the session');
    expect((err.cause as { code?: string } | undefined)?.code).toBe('ENOENT');
  });

  it('rethrows verbatim when the root is fine and only the write failed', async () => {
    const ctx = new ScoopContext(coneRecord(), callbacks(), await makeFs());
    const fs = {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async (path: string) => {
        throw fsError('ENOENT', path);
      }),
      writeFile: vi.fn(async () => {
        throw Object.assign(new Error('EIO: disk is on fire'), { code: 'EIO' });
      }),
      exists: vi.fn(async () => true),
    } as unknown as VirtualFS;

    // A real write failure on a healthy filesystem is not a storage outage —
    // dressing it up as one would send the user to reload for nothing.
    await expect(seedDirs(ctx, fs)).rejects.toThrow('EIO: disk is on fire');
  });

  it('still tolerates a read-only sandbox with nowhere to put a memory file', async () => {
    const ctx = new ScoopContext(coneRecord(), callbacks(), await makeFs());
    const exists = vi.fn(async () => true);
    const fs = {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async (path: string) => {
        throw fsError('ENOENT', path);
      }),
      writeFile: vi.fn(async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }),
      exists,
    } as unknown as VirtualFS;

    await expect(seedDirs(ctx, fs)).resolves.toBeUndefined();
    // EACCES short-circuits before the root check — a zero-write scoop is a
    // legitimate configuration, not a broken filesystem to go probing.
    expect(exists).not.toHaveBeenCalled();
  });
});
