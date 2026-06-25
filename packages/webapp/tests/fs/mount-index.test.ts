import { describe, expect, it } from 'vitest';
import { MountIndex } from '../../src/fs/mount-index.js';

/**
 * A self-referential FileSystemDirectoryHandle: it contains a file plus a
 * subdirectory `loop` that IS the same handle, so a naive recursive index walk
 * descends `/mnt/cyclic/loop/loop/loop/…` forever. This mirrors a real
 * self-nesting local mount (e.g. a repo checkout whose `.claude/worktrees/`
 * re-contains the repo), which pegged the kernel worker in substrate mode.
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
  it('terminates indexing on a self-referential mount instead of hanging', async () => {
    const index = new MountIndex();
    index.registerMount('/mnt/cyclic', makeCyclicHandle());

    // The bounded walk must reach a terminal state quickly. Without the depth /
    // entry caps the walk never returns and this stays 'indexing' until the
    // poll deadline, failing the assertion (and, in production, wedging the
    // worker). With the caps it aborts → 'error' (the mount falls back to the
    // slow per-readDir path).
    const status = await waitForTerminalState(index, '/mnt/cyclic', 4000);
    index.unregisterMount('/mnt/cyclic'); // abort the walk so it can't leak past the test

    expect(status).toBe('error');
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
