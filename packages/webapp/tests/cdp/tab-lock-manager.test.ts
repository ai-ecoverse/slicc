import { describe, expect, it } from 'vitest';

import { CommandAbortedError } from '../../src/cdp/command-abort.js';
import { TabLockManager } from '../../src/cdp/tab-lock-manager.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TabLockManager', () => {
  it('serializes holdTabLock on the same tab and leaves other tabs free', async () => {
    const locks = new TabLockManager();
    const order: string[] = [];

    const t1a = locks.holdTabLock('t1', undefined, async (counters) => {
      counters.acquisitions += 1;
      order.push('t1-start');
      await delay(30);
      order.push('t1-end');
    });

    await delay(5);
    const t1b = locks.holdTabLock('t1', undefined, async (counters) => {
      counters.acquisitions += 1;
      order.push('t1b');
    });
    const t2 = locks.holdTabLock('t2', undefined, async (counters) => {
      counters.acquisitions += 1;
      order.push('t2');
    });

    await Promise.all([t1a, t1b, t2]);
    expect(order.indexOf('t2')).toBeLessThan(order.indexOf('t1-end'));
    expect(order.indexOf('t1-end')).toBeLessThan(order.indexOf('t1b'));
    expect(locks.getStats('t1').acquisitions).toBe(2);
    expect(locks.getStats('t2').acquisitions).toBe(1);
  });

  it('records tabWaitMs only when a sibling contended the same tab', async () => {
    const locks = new TabLockManager();
    let releaseHold!: () => void;
    const hold = new Promise<void>((r) => {
      releaseHold = r;
    });

    const first = locks.holdTabLock('t1', undefined, async () => hold);
    await delay(5);
    const second = locks.holdTabLock('t1', undefined, async () => undefined);
    await delay(20);
    releaseHold();
    await Promise.all([first, second]);

    expect(locks.getStats('t1').tabWaitMs).toBeGreaterThan(0);
    expect(locks.getStats('t2').tabWaitMs).toBe(0);
  });

  it('aborts a queued tab lock without releasing the predecessor early', async () => {
    const locks = new TabLockManager();
    const ac = new AbortController();
    let releaseHold!: () => void;
    const hold = new Promise<void>((r) => {
      releaseHold = r;
    });

    const first = locks.holdTabLock('t1', undefined, async () => hold);
    await delay(5);
    const queued = locks.holdTabLock('t1', ac.signal, async () => 'ran');
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(CommandAbortedError);
    expect(locks.getStats('t1').queueDepth).toBe(1);

    releaseHold();
    await first;
    expect(locks.getStats('t1').queueDepth).toBe(0);
  });

  it('re-enters the bridge lock only with the live hold token', async () => {
    const locks = new TabLockManager();
    const release = await locks.acquireBridgeLock({ targetId: 't1' });
    const owner = locks.liveOwner();
    expect(owner).toBeDefined();

    const reenter = await locks.acquireBridgeLock({ owner, targetId: 't1' });
    reenter();
    expect(locks.liveOwner()).toBe(owner);

    expect(locks.reentrantOwner('t1')).toBe(owner);
    expect(locks.reentrantOwner('other')).toBeUndefined();
    expect(locks.reentrantOwner(null)).toBeUndefined();

    release();
    expect(locks.liveOwner()).toBeUndefined();
  });

  it('runGlobal holds the bridge lock for the body', async () => {
    const locks = new TabLockManager();
    let sawOwner = false;
    await locks.runGlobal('t1', async () => {
      sawOwner = locks.liveOwner() !== undefined;
      expect(locks.reentrantOwner('t1')).toBe(locks.liveOwner());
    });
    expect(sawOwner).toBe(true);
    expect(locks.liveOwner()).toBeUndefined();
  });

  it('sums per-tab stats when getStats is called without a target', async () => {
    const locks = new TabLockManager();
    await locks.holdTabLock('a', undefined, async (c) => {
      c.acquisitions += 1;
    });
    await locks.holdTabLock('b', undefined, async (c) => {
      c.acquisitions += 1;
    });
    expect(locks.getStats().acquisitions).toBe(2);
    expect(locks.getStats('never-touched')).toEqual({
      queueDepth: 0,
      totalWaitMs: 0,
      tabWaitMs: 0,
      bridgeWaitMs: 0,
      acquisitions: 0,
    });
  });

  it('idempotent bridge-lock release does not clear a newer hold', async () => {
    const locks = new TabLockManager();
    const first = await locks.acquireBridgeLock({ targetId: 't1' });
    first();
    first();
    const second = await locks.acquireBridgeLock({ targetId: 't2' });
    expect(locks.liveOwner()).toBeDefined();
    expect(locks.reentrantOwner('t2')).toBe(locks.liveOwner());
    second();
  });
});
