import { WebAccess } from '@zenfs/dom';
import { describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

const PRELOAD_LIMIT = 16;

async function makeBackend() {
  const tree = Object.fromEntries(
    Array.from({ length: 8 }, (_, directory) => [
      `d${directory}`,
      Object.fromEntries(Array.from({ length: 8 }, (_, file) => [`f${file}`, 'data'])),
    ])
  );
  return WebAccess.create({
    handle: createMutableDirectoryHandle(tree).handle,
    maxOpenFilesForCopy: PRELOAD_LIMIT,
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ZenFS preload concurrency across a directory tree', () => {
  it('bounds payload reads globally and preserves the synchronous cache', async () => {
    const backend = await makeBackend();
    const read = backend.read.bind(backend);
    let active = 0;
    let peak = 0;
    let finished = 0;
    vi.spyOn(backend, 'read').mockImplementation(async (...args) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await read(...args);
        finished++;
      } finally {
        active--;
      }
    });
    await backend.ready();
    // The limiter comes from the released core 2.7.3 + dom 1.2.14 pair;
    // SLICC configures 16 instead of accepting dom's default of 128.
    expect(peak).toBe(PRELOAD_LIMIT);
    expect(finished).toBe(64);
    expect(active).toBe(0);
    for (const path of ['/d0/f0', '/d7/f7']) {
      const bytes = new Uint8Array(4);
      backend.readSync(path, bytes, 0, 4);
      expect(new TextDecoder().decode(bytes)).toBe('data');
    }
  });

  it('does not copy file bodies above 1 MiB into the sync mirror', async () => {
    const backend = await makeBackend();
    const stat = backend.stat.bind(backend);
    const read = backend.read.bind(backend);
    const reads: string[] = [];
    vi.spyOn(backend, 'stat').mockImplementation(async (path: string) => {
      const stats = await stat(path);
      if (path === '/d0/f0') stats.size = 1048577;
      return stats;
    });
    vi.spyOn(backend, 'read').mockImplementation(async (...args: unknown[]) => {
      reads.push(String(args[0]));
      return read(...(args as Parameters<typeof read>));
    });
    await backend.ready();
    expect(reads).not.toContain('/d0/f0');
    expect(reads).toContain('/d0/f1');
    expect(backend.readdirSync('/d0')).toContain('f0');
    expect(backend.statSync('/d0/f0').size).toBe(1048577);
    expect(() => backend.readSync('/d0/f0', new Uint8Array(4), 0, 4)).toThrow(/no payload/);
  });

  it('follows a metadata-only path across rename, overwrite, and unlink', async () => {
    const backend = await makeBackend();
    const stat = backend.stat.bind(backend);
    vi.spyOn(backend, 'stat').mockImplementation(async (path: string) => {
      const stats = await stat(path);
      if (path === '/d0/f0') stats.size = 1048577;
      return stats;
    });
    await backend.ready();

    backend.renameSync('/d0/f0', '/d0/moved');
    // Before the queued rename copies bytes, the marker has to be on the new
    // path. Otherwise readSync would return zeros from the empty mirror.
    expect(() => backend.readSync('/d0/moved', new Uint8Array(4), 0, 4)).toThrow(/no payload/);
    await backend.sync();
    expect(() => backend.readSync('/d0/f0', new Uint8Array(4), 0, 4)).toThrow();
    const movedBytes = new Uint8Array(4);
    backend.readSync('/d0/moved', movedBytes, 0, 4);
    expect(new TextDecoder().decode(movedBytes)).toBe('data');

    const hello = new TextEncoder().encode('hello');
    backend.writeSync('/d0/moved', hello, 0);
    await backend.sync();
    const written = new Uint8Array(hello.length);
    backend.readSync('/d0/moved', written, 0, hello.length);
    expect(new TextDecoder().decode(written)).toBe('hello');
    expect(backend.statSync('/d0/moved').size).toBe(hello.length);

    backend.unlinkSync('/d0/moved');
    await backend.sync();
    backend.createFileSync('/d0/moved', { mode: 0o644 });
    const again = new TextEncoder().encode('again');
    backend.writeSync('/d0/moved', again, 0);
    const replaced = new Uint8Array(again.length);
    backend.readSync('/d0/moved', replaced, 0, again.length);
    expect(new TextDecoder().decode(replaced)).toBe('again');
    await backend.sync();
  });

  it.each(['read', 'stat', 'readdir', 'slot handoff'] as const)(
    'cancels queued copies on %s failure, drains active copies, and preserves the first error',
    async (failureSite) => {
      const backend = await makeBackend();
      const read = backend.read.bind(backend);
      const stat = backend.stat.bind(backend);
      const readdir = backend.readdir.bind(backend);
      const firstFailure = new Error('First failure');
      const laterFailure = new Error('Later failure in an earlier directory');
      const allStarted = deferred();
      const fail = deferred();
      const finish = deferred();
      const handoff = deferred();
      let active = 0;
      let started = 0;
      let finished = 0;
      let settled = false;
      vi.spyOn(backend, 'stat').mockImplementation(async (path) => {
        if (failureSite === 'stat' && path === '/d7') await fail.promise;
        return stat(path);
      });
      vi.spyOn(backend, 'readdir').mockImplementation(async (path) => {
        if (failureSite === 'readdir' && path === '/d7') await fail.promise;
        return readdir(path);
      });
      vi.spyOn(backend, 'read').mockImplementation(async (...args) => {
        active++;
        if (++started === PRELOAD_LIMIT) allStarted.resolve();
        try {
          if (failureSite === 'slot handoff' && args[0] === '/d0/f0') {
            await handoff.promise;
            return;
          }
          if ((failureSite === 'read' || failureSite === 'slot handoff') && args[0] === '/d1/f0') {
            await fail.promise;
          }
          await finish.promise;
          if (args[0] === '/d0/f1') throw laterFailure;
          await read(...args);
        } finally {
          finished++;
          active--;
        }
      });
      // Attach both handlers immediately: the test controls when ready() may reject.
      const outcome = backend.ready().then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      try {
        await allStarted.promise;
        // Hand a slot to a waiter just before the peer failure is observed.
        if (failureSite === 'slot handoff') handoff.resolve();
        fail.reject(firstFailure);
        // Let promise continuations observe the failure while other reads stay blocked.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(started).toBe(PRELOAD_LIMIT);
        const expectedActive = {
          read: PRELOAD_LIMIT - 1,
          stat: PRELOAD_LIMIT,
          readdir: PRELOAD_LIMIT,
          'slot handoff': PRELOAD_LIMIT - 2,
        };
        expect(active).toBe(expectedActive[failureSite]);
        expect(settled).toBe(false);
        finish.resolve();
        expect(await outcome).toBe(firstFailure);
        expect(active).toBe(0);
        expect(finished).toBe(PRELOAD_LIMIT);
        expect(started).toBe(PRELOAD_LIMIT);
        expect(backend.existsSync('/d2/f0')).toBe(false);
      } finally {
        handoff.resolve();
        fail.reject(firstFailure);
        finish.resolve();
        await outcome;
      }
    }
  );
});
