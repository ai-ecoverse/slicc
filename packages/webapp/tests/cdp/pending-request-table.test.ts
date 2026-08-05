import { describe, expect, it, vi } from 'vitest';

import { PendingRequestTable, waitForEvent } from '../../src/cdp/pending-request-table.js';

describe('PendingRequestTable', () => {
  it('resolve() settles the issued promise and drops the entry', async () => {
    const table = new PendingRequestTable<number>();

    const promise = table.issue(1, 5000, 'timed out');
    expect(table.size).toBe(1);

    table.resolve(1, { ok: true });

    expect(await promise).toEqual({ ok: true });
    expect(table.size).toBe(0);
  });

  it('reject() settles the issued promise with the given error', async () => {
    const table = new PendingRequestTable<number>();

    const promise = table.issue(1, 5000, 'timed out');
    table.reject(1, new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(table.size).toBe(0);
  });

  it('rejects with the timeout message and drops the entry', async () => {
    vi.useFakeTimers();
    const table = new PendingRequestTable<number>();

    const promise = table.issue(1, 100, 'timed out after 100ms');
    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow('timed out after 100ms');
    expect(table.size).toBe(0);
    vi.useRealTimers();
  });

  it('settling an unknown or already-settled id is a no-op', async () => {
    const table = new PendingRequestTable<number>();

    const promise = table.issue(1, 5000, 'timed out');
    table.resolve(1, { first: true });
    table.resolve(1, { second: true });
    table.reject(2, new Error('unknown'));

    expect(await promise).toEqual({ first: true });
  });

  it('has() reports whether a request is in flight', async () => {
    const table = new PendingRequestTable<string>();

    const promise = table.issue('a', 5000, 'timed out');
    expect(table.has('a')).toBe(true);
    expect(table.has('b')).toBe(false);

    table.resolve('a', {});
    await promise;
    expect(table.has('a')).toBe(false);
  });

  it('rejectAll() fails every in-flight request and clears their timers', async () => {
    vi.useFakeTimers();
    const table = new PendingRequestTable<number>();

    const p1 = table.issue(1, 100, 'timed out');
    const p2 = table.issue(2, 100, 'timed out');

    table.rejectAll('transport disconnected');

    await expect(p1).rejects.toThrow('transport disconnected');
    await expect(p2).rejects.toThrow('transport disconnected');
    expect(table.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('waitForEvent', () => {
  it('resolves with the first delivered value and unsubscribes', async () => {
    let handler: ((value: number) => void) | null = null;
    const unsubscribe = vi.fn();

    const promise = waitForEvent<number>(
      (h) => {
        handler = h;
        return unsubscribe;
      },
      5000,
      'timed out'
    );

    handler!(42);

    expect(await promise).toBe(42);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes a synchronously-delivering subscriber', async () => {
    const unsubscribe = vi.fn();

    const promise = waitForEvent<number>(
      (h) => {
        h(7);
        return unsubscribe;
      },
      5000,
      'timed out'
    );

    expect(await promise).toBe(7);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rejects with the timeout message and unsubscribes', async () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();

    const promise = waitForEvent<number>(() => unsubscribe, 100, 'timed out waiting');
    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow('timed out waiting');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
