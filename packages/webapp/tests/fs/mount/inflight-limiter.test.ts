import { describe, expect, it } from 'vitest';

import { createInflightLimiter } from '../../../src/fs/mount/inflight-limiter.js';

/** A promise plus its resolver, so a test can hold a call open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createInflightLimiter', () => {
  it('never runs more than `max` calls at once and drains the queue', async () => {
    const limiter = createInflightLimiter(3);
    const gates = Array.from({ length: 10 }, () => deferred());
    let concurrent = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      limiter.run(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate.promise;
        concurrent -= 1;
      })
    );

    // Only the first 3 may have started; the rest are queued.
    await Promise.resolve();
    expect(peak).toBe(3);

    for (const gate of gates) {
      gate.resolve();
      await Promise.resolve();
    }
    await Promise.all(runs);
    expect(peak).toBe(3);
    expect(limiter.active).toBe(0);
  });

  it('releases the slot when a call rejects', async () => {
    const limiter = createInflightLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    expect(limiter.active).toBe(0);
  });

  it('clamps a max below 1 to a single slot', async () => {
    const limiter = createInflightLimiter(0);
    const gate = deferred();
    let started = 0;
    const first = limiter.run(async () => {
      started += 1;
      await gate.promise;
    });
    const second = limiter.run(async () => {
      started += 1;
    });
    await Promise.resolve();
    expect(started).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toBe(2);
  });

  it('passes calls straight through when max is not finite', async () => {
    const limiter = createInflightLimiter(Number.POSITIVE_INFINITY);
    const gates = Array.from({ length: 5 }, () => deferred());
    let concurrent = 0;
    const runs = gates.map((gate) =>
      limiter.run(async () => {
        concurrent += 1;
        await gate.promise;
      })
    );
    await Promise.resolve();
    expect(concurrent).toBe(5);
    expect(limiter.active).toBe(0);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
  });
});
