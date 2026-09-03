/**
 * Unit tests for the realm timer-handle tracker. Installs against a
 * fake global so vitest's own timers stay untouched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTimerHandleTracker } from '../../../src/kernel/realm/realm-timer-handles.js';

function fakeGlobal(): typeof globalThis {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  } as typeof globalThis;
}

describe('createTimerHandleTracker', () => {
  const trackers: ReturnType<typeof createTimerHandleTracker>[] = [];

  afterEach(() => {
    for (const t of trackers) {
      t.clearPending();
      t.restore();
    }
    trackers.length = 0;
  });

  function installed(): {
    g: typeof globalThis;
    timers: ReturnType<typeof createTimerHandleTracker>;
  } {
    const g = fakeGlobal();
    const timers = createTimerHandleTracker(g);
    timers.install();
    trackers.push(timers);
    return { g, timers };
  }

  it('counts a setTimeout until it fires', async () => {
    const { g, timers } = installed();
    expect(timers.pendingCount).toBe(0);
    const fired = new Promise<void>((resolve) => {
      g.setTimeout(() => resolve(), 0);
    });
    expect(timers.pendingCount).toBe(1);
    await fired;
    expect(timers.pendingCount).toBe(0);
  });

  it('forwards extra setTimeout arguments to the callback', async () => {
    const { g } = installed();
    const got = await new Promise<unknown[]>((resolve) => {
      g.setTimeout((a: unknown, b: unknown) => resolve([a, b]), 0, 'x', 2);
    });
    expect(got).toEqual(['x', 2]);
  });

  it('stops counting a timeout that clearTimeout cancelled', async () => {
    const { g, timers } = installed();
    const id = g.setTimeout(() => {
      throw new Error('cleared timeout must not fire');
    }, 20);
    expect(timers.pendingCount).toBe(1);
    g.clearTimeout(id);
    expect(timers.pendingCount).toBe(0);
    await timers.tick();
    await timers.tick();
  });

  it('counts setInterval until clearInterval', async () => {
    const { g, timers } = installed();
    let n = 0;
    const id = g.setInterval(() => {
      n += 1;
      if (n >= 2) g.clearInterval(id);
    }, 5);
    expect(timers.pendingCount).toBe(1);
    await new Promise<void>((resolve) => {
      const watch = g.setInterval(() => {
        if (n >= 2) {
          g.clearInterval(watch);
          resolve();
        }
      }, 5);
    });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(timers.pendingCount).toBe(0);
  });

  it('clearPending cancels callbacks without running them', async () => {
    const { g, timers } = installed();
    let fired = false;
    g.setTimeout(() => {
      fired = true;
    }, 0);
    expect(timers.pendingCount).toBe(1);
    timers.clearPending();
    expect(timers.pendingCount).toBe(0);
    await timers.tick();
    await timers.tick();
    expect(fired).toBe(false);
  });

  it('restore puts the original timers back', () => {
    const { g, timers } = installed();
    const wrapped = g.setTimeout;
    timers.restore();
    expect(g.setTimeout).not.toBe(wrapped);
  });
});
