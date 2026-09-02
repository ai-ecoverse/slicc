import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel, resetLoggerDedupForTests, setLogLevel } from '../../src/base/logger.js';
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

function makeDirectoryHandle(
  entries: Array<[string, FileSystemHandle]>
): FileSystemDirectoryHandle {
  return {
    kind: 'directory' as const,
    async *[Symbol.asyncIterator](): AsyncGenerator<[string, FileSystemHandle]> {
      yield* entries;
    },
  } as unknown as FileSystemDirectoryHandle;
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
    // cap is the safety net. Lower the cap via the resolved per-mount limits
    // (sourced from the shell env, not process.env) so the test is fast.
    const index = new MountIndex();
    index.registerMount(
      '/mnt/deep',
      makeCyclicHandle(),
      resolveMountIndexLimits(new Map([['SLICC_MOUNT_INDEX_MAX_DEPTH', '3']]))
    );

    const status = await waitForTerminalState(index, '/mnt/deep', 4000);
    const state = index.getState('/mnt/deep');
    index.unregisterMount('/mnt/deep');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('depth-exceeded');
  }, 9000);

  it('aborts with abortCause "entries-exceeded" when the entry budget is hit', async () => {
    const index = new MountIndex();
    index.registerMount(
      '/mnt/big',
      makeWideHandle(),
      resolveMountIndexLimits(new Map([['SLICC_MOUNT_INDEX_MAX_ENTRIES', '2']]))
    );

    const status = await waitForTerminalState(index, '/mnt/big', 4000);
    const state = index.getState('/mnt/big');
    index.unregisterMount('/mnt/big');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('entries-exceeded');
  }, 9000);

  it('aborts a huge flat directory DURING read, before buffering every child', async () => {
    // A single directory with far more immediate children than the entry budget.
    // The in-read budget check must abort once the running total would exceed
    // maxEntries instead of buffering the full listing first (OOM guard).
    let yielded = 0;
    const flat = {
      kind: 'directory' as const,
      async *[Symbol.asyncIterator](): AsyncGenerator<[string, { kind: 'file' | 'directory' }]> {
        for (let i = 0; i < 1000; i++) {
          yielded++;
          yield [`f${i}.txt`, { kind: 'file' }];
        }
      },
    } as unknown as FileSystemDirectoryHandle;

    const index = new MountIndex();
    index.registerMount('/mnt/flat', flat, { maxDepth: 400, maxEntries: 5, skipNoiseDirs: true });

    const status = await waitForTerminalState(index, '/mnt/flat', 4000);
    const state = index.getState('/mnt/flat');
    index.unregisterMount('/mnt/flat');

    expect(status).toBe('error');
    expect(state?.abortCause).toBe('entries-exceeded');
    // Proves the abort happened mid-read, not after materializing all 1000.
    expect(yielded).toBeLessThan(1000);
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

describe('MountIndex directory entries', () => {
  const fileHandle = { kind: 'file' as const } as FileSystemHandle;

  it('lists a small directory without scanning 10,000 unrelated indexed paths', async () => {
    const rootEntries: Array<[string, FileSystemHandle]> = [];
    for (let bucket = 0; bucket < 100; bucket++) {
      const bucketEntries: Array<[string, FileSystemHandle]> = [];
      for (let file = 0; file < 100; file++) {
        bucketEntries.push([`file-${file}.txt`, fileHandle]);
      }
      rootEntries.push([`bucket-${bucket}`, makeDirectoryHandle(bucketEntries)]);
    }
    rootEntries.push([
      'target',
      makeDirectoryHandle([
        ['first.ts', fileHandle],
        ['second.ts', fileHandle],
      ]),
    ]);

    const index = new MountIndex();
    index.registerMount('/mnt/large', makeDirectoryHandle(rootEntries));
    expect(await waitForTerminalState(index, '/mnt/large', 9000)).toBe('ready');

    const mountData = (
      index as unknown as {
        mounts: Map<string, { files: Set<string>; directories: Set<string> }>;
      }
    ).mounts.get('/mnt/large');
    expect(mountData).toBeDefined();

    const fileIterator = vi.spyOn(mountData!.files, Symbol.iterator).mockImplementation(() => {
      throw new Error('getDirectoryEntries scanned all files');
    });
    const directoryIterator = vi
      .spyOn(mountData!.directories, Symbol.iterator)
      .mockImplementation(() => {
        throw new Error('getDirectoryEntries scanned all directories');
      });

    expect(index.getDirectoryEntries('/mnt/large', '/mnt/large/target')).toEqual([
      { name: 'first.ts', type: 'file' },
      { name: 'second.ts', type: 'file' },
    ]);

    fileIterator.mockRestore();
    directoryIterator.mockRestore();
    index.unregisterMount('/mnt/large');
  }, 15_000);

  it('keeps directory child buckets current across writes, renames, and deletes', async () => {
    const index = new MountIndex();
    index.registerMount(
      '/mnt/project',
      makeDirectoryHandle([
        ['README.md', fileHandle],
        ['src', makeDirectoryHandle([['app.ts', fileHandle]])],
      ])
    );
    expect(await waitForTerminalState(index, '/mnt/project', 4000)).toBe('ready');

    index.notifyWrite('/mnt/project/src/new.ts');
    expect(index.getDirectoryEntries('/mnt/project', '/mnt/project/src')).toEqual([
      { name: 'app.ts', type: 'file' },
      { name: 'new.ts', type: 'file' },
    ]);

    index.notifyRename('/mnt/project/src/new.ts', '/mnt/project/src/renamed.ts');
    index.notifyRename('/mnt/project/src', '/mnt/project/lib');
    expect(index.getDirectoryEntries('/mnt/project', '/mnt/project')).toEqual([
      { name: 'README.md', type: 'file' },
      { name: 'lib', type: 'directory' },
    ]);
    expect(index.getDirectoryEntries('/mnt/project', '/mnt/project/lib')).toEqual([
      { name: 'app.ts', type: 'file' },
      { name: 'renamed.ts', type: 'file' },
    ]);

    index.notifyDelete('/mnt/project/lib');
    expect(index.getDirectoryEntries('/mnt/project', '/mnt/project')).toEqual([
      { name: 'README.md', type: 'file' },
    ]);
    expect(index.hasPath('/mnt/project', '/mnt/project/lib/app.ts')).toBe(false);
  });
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
    expect(limits).toEqual({ maxDepth: 12, maxEntries: 500, skipNoiseDirs: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to defaults and warns on invalid values', () => {
    const limits = resolveMountIndexLimits({
      SLICC_MOUNT_INDEX_MAX_DEPTH: '-5',
      SLICC_MOUNT_INDEX_MAX_ENTRIES: 'not-a-number',
    });
    expect(limits).toEqual({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEntries: DEFAULT_MAX_ENTRIES,
      skipNoiseDirs: true,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('uses defaults silently when the env vars are absent', () => {
    const limits = resolveMountIndexLimits({});
    expect(limits).toEqual({
      maxDepth: DEFAULT_MAX_DEPTH,
      maxEntries: DEFAULT_MAX_ENTRIES,
      skipNoiseDirs: true,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('reads overrides from a just-bash env Map (ctx.env shape)', () => {
    const limits = resolveMountIndexLimits(
      new Map([
        ['SLICC_MOUNT_INDEX_MAX_DEPTH', '12'],
        ['SLICC_MOUNT_INDEX_MAX_ENTRIES', '500'],
      ])
    );
    expect(limits).toEqual({ maxDepth: 12, maxEntries: 500, skipNoiseDirs: true });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('MountIndex noise-directory skip', () => {
  const fileHandle = { kind: 'file' as const } as FileSystemHandle;

  /** Project tree with useful files plus huge noise under node_modules and .git. */
  function makeNoisyProjectHandle(): FileSystemDirectoryHandle {
    const noiseFiles: Array<[string, FileSystemHandle]> = [];
    for (let i = 0; i < 20; i++) {
      noiseFiles.push([`pkg-${i}.js`, fileHandle]);
    }
    return makeDirectoryHandle([
      ['README.md', fileHandle],
      ['src', makeDirectoryHandle([['app.ts', fileHandle]])],
      ['node_modules', makeDirectoryHandle(noiseFiles)],
      [
        '.git',
        makeDirectoryHandle([
          ['HEAD', fileHandle],
          ['config', fileHandle],
        ]),
      ],
      ['dist', makeDirectoryHandle([['bundle.js', fileHandle]])],
    ]);
  }

  it('skips node_modules, .git, and build output by default', async () => {
    const index = new MountIndex();
    index.registerMount('/mnt/repo', makeNoisyProjectHandle());
    expect(await waitForTerminalState(index, '/mnt/repo', 4000)).toBe('ready');

    expect(index.getFiles('/mnt/repo')?.sort()).toEqual([
      '/mnt/repo/README.md',
      '/mnt/repo/src/app.ts',
    ]);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/node_modules')).toBe(false);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/.git')).toBe(false);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/dist')).toBe(false);
    expect(
      index
        .getDirectoryEntries('/mnt/repo', '/mnt/repo')
        ?.map((e) => e.name)
        .sort()
    ).toEqual(['README.md', 'src']);
    // Absolute path into a skipped subtree must not pretend the dir is empty.
    expect(index.getDirectoryEntries('/mnt/repo', '/mnt/repo/node_modules')).toBeUndefined();
    index.unregisterMount('/mnt/repo');
  }, 9000);

  it('indexes noise directories when skipNoiseDirs is false', async () => {
    const index = new MountIndex();
    index.registerMount('/mnt/repo', makeNoisyProjectHandle(), {
      ...resolveMountIndexLimits({}),
      skipNoiseDirs: false,
    });
    expect(await waitForTerminalState(index, '/mnt/repo', 4000)).toBe('ready');

    expect(index.hasPath('/mnt/repo', '/mnt/repo/node_modules/pkg-0.js')).toBe(true);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/.git/HEAD')).toBe(true);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/dist/bundle.js')).toBe(true);
    index.unregisterMount('/mnt/repo');
  }, 9000);

  it('reaches the entry budget later when noise dirs are skipped', async () => {
    // Same tree, tight budget: with skip the useful files fit; without skip,
    // node_modules alone blows the budget before src is reached.
    const tight = { maxDepth: 400, maxEntries: 8, skipNoiseDirs: true as const };

    const skipped = new MountIndex();
    skipped.registerMount('/mnt/fit', makeNoisyProjectHandle(), tight);
    expect(await waitForTerminalState(skipped, '/mnt/fit', 4000)).toBe('ready');
    expect(skipped.hasPath('/mnt/fit', '/mnt/fit/src/app.ts')).toBe(true);
    skipped.unregisterMount('/mnt/fit');

    const unfiltered = new MountIndex();
    unfiltered.registerMount('/mnt/blow', makeNoisyProjectHandle(), {
      ...tight,
      skipNoiseDirs: false,
    });
    const status = await waitForTerminalState(unfiltered, '/mnt/blow', 4000);
    expect(status).toBe('error');
    expect(unfiltered.getState('/mnt/blow')?.abortCause).toBe('entries-exceeded');
    unfiltered.unregisterMount('/mnt/blow');
  }, 9000);

  it('does not partially populate skipped subtrees on write/rename/delete', async () => {
    const index = new MountIndex();
    index.registerMount('/mnt/repo', makeNoisyProjectHandle());
    expect(await waitForTerminalState(index, '/mnt/repo', 4000)).toBe('ready');

    // A post-index write under node_modules must leave the subtree unindexed
    // so getDirectoryEntries keeps falling back to the slow path.
    index.notifyWrite('/mnt/repo/node_modules/pkg-0.js');
    index.notifyWrite('/mnt/repo/.git/config');
    expect(index.hasPath('/mnt/repo', '/mnt/repo/node_modules/pkg-0.js')).toBe(false);
    expect(index.getDirectoryEntries('/mnt/repo', '/mnt/repo/node_modules')).toBeUndefined();
    expect(index.getDirectoryEntries('/mnt/repo', '/mnt/repo')?.map((e) => e.name)).not.toContain(
      'node_modules'
    );

    // Dot-files at the mount root are still files, not skipped directories.
    index.notifyWrite('/mnt/repo/.env');
    expect(index.hasPath('/mnt/repo', '/mnt/repo/.env')).toBe(true);

    // Rename into noise drops the indexed source; destination stays unindexed.
    index.notifyRename('/mnt/repo/README.md', '/mnt/repo/node_modules/README.md');
    expect(index.hasPath('/mnt/repo', '/mnt/repo/README.md')).toBe(false);
    expect(index.hasPath('/mnt/repo', '/mnt/repo/node_modules/README.md')).toBe(false);
    expect(index.getDirectoryEntries('/mnt/repo', '/mnt/repo/node_modules')).toBeUndefined();

    // Mutations that stay inside noise are no-ops on the index.
    index.notifyDelete('/mnt/repo/node_modules/pkg-0.js');
    index.notifyRename('/mnt/repo/.git/HEAD', '/mnt/repo/.git/ORIG_HEAD');
    expect(index.getDirectoryEntries('/mnt/repo', '/mnt/repo/.git')).toBeUndefined();

    index.unregisterMount('/mnt/repo');
  }, 9000);
});
