import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel, resetLoggerDedupForTests, setLogLevel } from '../../src/core/logger.js';
import { MountIndex, resolveMountIndexLimits } from '../../src/fs/mount-index.js';

/**
 * A self-referential FileSystemDirectoryHandle: it contains a file plus a
 * subdirectory `loop` that IS the same handle, so a naive recursive index walk
 * descends `/mnt/cyclic/loop/loop/loop/…` forever. This mirrors a real
 * self-nesting local mount (e.g. a repo checkout whose `.claude/worktrees/`
 * re-contains the repo), which pegged the kernel worker in substrate mode.
 *
 * This variant has NO `isSameEntry` (like the in-memory Node FS), so exact
 * cycle confirmation can't run — the depth cap is the safety net.
 */
function makeCyclicHandle(): FileSystemDirectoryHandle {
  const self = {
    kind: 'directory' as const,
    async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
      yield ['file.txt', { kind: 'file' }];
      yield ['loop', self];
    },
  };
  return self as unknown as FileSystemDirectoryHandle;
}

/**
 * Like `makeCyclicHandle` but it implements `isSameEntry`, returning true when
 * compared against itself — so the fingerprint prefilter is confirmed by an
 * exact match and the walk aborts with `'cycle-detected'` rather than falling
 * through to the depth cap.
 */
function makeCyclicHandleWithIdentity(): FileSystemDirectoryHandle {
  const self = {
    kind: 'directory' as const,
    isSameEntry: async (other: unknown) => other === self,
    async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
      yield ['file.txt', { kind: 'file' }];
      yield ['loop', self];
    },
  };
  return self as unknown as FileSystemDirectoryHandle;
}

/**
 * A finite tree with several files plus a subdirectory, so the per-directory
 * entry-budget check fires when descending into `sub`.
 */
function makeWideHandle(): FileSystemDirectoryHandle {
  const sub = {
    kind: 'directory' as const,
    async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
      yield ['x.txt', { kind: 'file' }];
    },
  };
  const root = {
    kind: 'directory' as const,
    async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
      yield ['a.txt', { kind: 'file' }];
      yield ['b.txt', { kind: 'file' }];
      yield ['c.txt', { kind: 'file' }];
      yield ['sub', sub];
    },
  };
  return root as unknown as FileSystemDirectoryHandle;
}

async function waitForTerminalState(
  index: MountIndex,
  path: string,
  timeoutMs: number
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let state = index.getState(path);
  while (Date.now() < deadline && (state?.status === 'indexing' || state?.status === 'pending')) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = index.getState(path);
  }
  return state?.status;
}

describe('MountIndex cycle safety', () => {
  const savedEnv = {
    depth: process.env.SLICC_MOUNT_INDEX_MAX_DEPTH,
    entries: process.env.SLICC_MOUNT_INDEX_MAX_ENTRIES,
  };

  afterEach(() => {
    if (savedEnv.depth === undefined) delete process.env.SLICC_MOUNT_INDEX_MAX_DEPTH;
    else process.env.SLICC_MOUNT_INDEX_MAX_DEPTH = savedEnv.depth;
    if (savedEnv.entries === undefined) delete process.env.SLICC_MOUNT_INDEX_MAX_ENTRIES;
    else process.env.SLICC_MOUNT_INDEX_MAX_ENTRIES = savedEnv.entries;
  });

  it('aborts a self-referential mount with abortCause "cycle-detected" via isSameEntry', async () => {
    const index = new MountIndex();
    index.registerMount('/mnt/cyclic', makeCyclicHandleWithIdentity());

    // The fingerprint prefilter matches the re-exposed ancestor, and the exact
    // isSameEntry() confirmation proves the cycle — so the walk aborts as
    // 'cycle-detected' (not merely depth-exceeded) and falls back to the slow
    // per-readDir path.
    const status = await waitForTerminalState(index, '/mnt/cyclic', 4000);
    const state = index.getState('/mnt/cyclic');
    index.unregisterMount('/mnt/cyclic'); // abort the walk so it can't leak past the test

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('cycle-detected');
  }, 9000);

  it('aborts with abortCause "depth-exceeded" when nesting exceeds the depth bound', async () => {
    // No isSameEntry on this handle, so cycle confirmation can't run — the depth
    // cap is the safety net. Lower the cap via env so the test is fast.
    process.env.SLICC_MOUNT_INDEX_MAX_DEPTH = '3';
    const index = new MountIndex();
    index.registerMount('/mnt/deep', makeCyclicHandle());

    const status = await waitForTerminalState(index, '/mnt/deep', 4000);
    const state = index.getState('/mnt/deep');
    index.unregisterMount('/mnt/deep');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('depth-exceeded');
  }, 9000);

  it('aborts with abortCause "entries-exceeded" when the entry budget is hit', async () => {
    process.env.SLICC_MOUNT_INDEX_MAX_ENTRIES = '2';
    const index = new MountIndex();
    index.registerMount('/mnt/big', makeWideHandle());

    const status = await waitForTerminalState(index, '/mnt/big', 4000);
    const state = index.getState('/mnt/big');
    index.unregisterMount('/mnt/big');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('entries-exceeded');
  }, 9000);

  it('marks a generic backend failure with abortCause "indexing-error"', async () => {
    // A handle whose iteration throws a non-bound error: still terminal 'error',
    // but it is NOT a classified abort, so it falls back to the generic cause.
    const failing = {
      kind: 'directory' as const,
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(new Error('backend unavailable')) };
      },
    } as unknown as FileSystemDirectoryHandle;

    const index = new MountIndex();
    index.registerMount('/mnt/broken', failing);

    const status = await waitForTerminalState(index, '/mnt/broken', 4000);
    const state = index.getState('/mnt/broken');
    index.unregisterMount('/mnt/broken');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('indexing-error');
  }, 9000);

  it('indexes a normal finite tree to ready', async () => {
    const finite = {
      kind: 'directory' as const,
      async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
        yield ['a.txt', { kind: 'file' }];
        yield ['b.txt', { kind: 'file' }];
      },
    } as unknown as FileSystemDirectoryHandle;

    const index = new MountIndex();
    index.registerMount('/mnt/finite', finite);

    const status = await waitForTerminalState(index, '/mnt/finite', 4000);

    expect(status).toBe('ready');
    expect(index.getState('/mnt/finite')?.indexed).toBe(3); // 2 files + the root dir
  }, 9000);
});

describe('resolveMountIndexLimits', () => {
  const DEFAULT_MAX_DEPTH = 400;
  const DEFAULT_MAX_ENTRIES = 2_000_000;

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetLoggerDedupForTests();
    setLogLevel(LogLevel.WARN);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reads positive-integer overrides from the env snapshot', () => {
    const limits = resolveMountIndexLimits({
      SLICC_MOUNT_INDEX_MAX_DEPTH: '12',
      SLICC_MOUNT_INDEX_MAX_ENTRIES: '500',
    });
    expect(limits).toEqual({ maxDepth: 12, maxEntries: 500 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to defaults and warns on invalid values', () => {
    const limits = resolveMountIndexLimits({
      SLICC_MOUNT_INDEX_MAX_DEPTH: '-5',
      SLICC_MOUNT_INDEX_MAX_ENTRIES: 'not-a-number',
    });
    expect(limits).toEqual({ maxDepth: DEFAULT_MAX_DEPTH, maxEntries: DEFAULT_MAX_ENTRIES });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('uses defaults silently when the env vars are absent', () => {
    const limits = resolveMountIndexLimits({});
    expect(limits).toEqual({ maxDepth: DEFAULT_MAX_DEPTH, maxEntries: DEFAULT_MAX_ENTRIES });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
