import { describe, expect, it } from 'vitest';
import { allSettledOrThrow, createLimiter } from '../../../src/shell/ipk/concurrency.js';
import { trackInFlight } from './helpers/in-flight.js';

describe('createLimiter', () => {
  it('never runs more than `limit` tasks at once and runs them all', async () => {
    const limit = createLimiter(3);
    const tracked = trackInFlight(async (n: number) => n * 2);
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => limit(() => tracked.fn(i))));
    expect(out).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(tracked.stats.max).toBe(3);
  });

  it('starts queued tasks in FIFO order', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limit(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the slot when a task rejects', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit(async () => 'next')).resolves.toBe('next');
  });

  it('treats a limit below 1 as 1', async () => {
    const limit = createLimiter(0);
    const tracked = trackInFlight(async () => undefined);
    await Promise.all([1, 2, 3].map(() => limit(tracked.fn)));
    expect(tracked.stats.max).toBe(1);
  });
});

describe('allSettledOrThrow', () => {
  it('resolves with every value in order', async () => {
    await expect(allSettledOrThrow([Promise.resolve(1), Promise.resolve(2)])).resolves.toEqual([
      1, 2,
    ]);
  });

  it('waits for every promise before rethrowing the first rejection in array order', async () => {
    let slowDone = false;
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        slowDone = true;
        resolve();
      }, 20)
    );
    const err = await allSettledOrThrow([
      slow,
      Promise.reject(new Error('first')),
      Promise.reject(new Error('second')),
    ]).catch((e: unknown) => e);
    expect((err as Error).message).toBe('first');
    expect(slowDone).toBe(true);
  });
});
