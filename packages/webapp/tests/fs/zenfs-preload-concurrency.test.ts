import { WebAccess } from '@zenfs/dom';
import { describe, expect, it, vi } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

async function makeBackend() {
  const tree = Object.fromEntries(
    Array.from({ length: 8 }, (_, directory) => [
      `d${directory}`,
      Object.fromEntries(Array.from({ length: 8 }, (_, file) => [`f${file}`, 'data'])),
    ])
  );
  return WebAccess.create({ handle: createMutableDirectoryHandle(tree).handle });
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
    expect(peak).toBe(16);
    expect(finished).toBe(64);
    expect(active).toBe(0);
    for (const path of ['/d0/f0', '/d7/f7']) {
      const bytes = new Uint8Array(4);
      backend.readSync(path, bytes, 0, 4);
      expect(new TextDecoder().decode(bytes)).toBe('data');
    }
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
        if (++started === 16) allStarted.resolve();
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
        expect(started).toBe(16);
        const expectedActive = { read: 15, stat: 16, readdir: 16, 'slot handoff': 14 };
        expect(active).toBe(expectedActive[failureSite]);
        expect(settled).toBe(false);
        finish.resolve();
        expect(await outcome).toBe(firstFailure);
        expect(active).toBe(0);
        expect(finished).toBe(16);
        expect(started).toBe(16);
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
