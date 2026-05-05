import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithBudget } from '../../../src/fs/mount/fetch-with-budget.js';

describe('fetchWithBudget — per-attempt timeout', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('aborts an attempt after perAttemptMs and surfaces the AbortError', async () => {
    let abortCount = 0;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          abortCount++;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as typeof globalThis.fetch;

    const promise = fetchWithBudget(new Request('https://example.test/x'), {
      maxAttempts: 1,
      perAttemptMs: 100,
      totalBudgetMs: 200,
    });
    // Pre-attach a noop handler so the rejection isn't flagged as unhandled
    // when vitest's fake timers fire the abort synchronously (the awaiter
    // below still sees the rejection via expect.rejects).
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(150);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortCount).toBe(1);
  });
});

describe('fetchWithBudget — retry semantics', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('retries 5xx up to maxAttempts then succeeds', async () => {
    const responses = [
      new Response('boom', { status: 503 }),
      new Response('boom', { status: 503 }),
      new Response('ok', { status: 200 }),
    ];
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return responses[callCount - 1];
    }) as typeof globalThis.fetch;

    const promise = fetchWithBudget(new Request('https://x.test/y'), {
      maxAttempts: 3,
      perAttemptMs: 1_000,
      totalBudgetMs: 10_000,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(callCount).toBe(3);
  });

  it('returns 5xx on the final attempt instead of throwing', async () => {
    const responses = [
      new Response('boom', { status: 502 }),
      new Response('still boom', { status: 502 }),
    ];
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      return responses[callCount - 1];
    }) as typeof globalThis.fetch;

    const promise = fetchWithBudget(new Request('https://x.test/y'), {
      maxAttempts: 2,
      perAttemptMs: 1_000,
      totalBudgetMs: 10_000,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(502);
    expect(callCount).toBe(2);
  });

  it('honors Retry-After header (overriding the schedule)', async () => {
    const responses = [
      new Response('busy', { status: 429, headers: { 'Retry-After': '2' } }),
      new Response('ok', { status: 200 }),
    ];
    let callCount = 0;
    const callTimes: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      callTimes.push(Date.now());
      return responses[callCount - 1];
    }) as typeof globalThis.fetch;

    const startedAt = Date.now();
    const promise = fetchWithBudget(new Request('https://x.test/y'), {
      maxAttempts: 2,
      perAttemptMs: 1_000,
      totalBudgetMs: 10_000,
    });
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    // Second call happens at least 2000ms after the first (Retry-After: 2).
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(2_000);
    expect(callTimes[0] - startedAt).toBeLessThan(50);
  });

  it('outer abort cancels in-flight fetch', async () => {
    const controller = new AbortController();
    let aborted = false;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const sig = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        sig?.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }) as typeof globalThis.fetch;

    const promise = fetchWithBudget(new Request('https://x.test/y'), {
      maxAttempts: 3,
      perAttemptMs: 10_000,
      totalBudgetMs: 30_000,
      signal: controller.signal,
    });
    promise.catch(() => undefined);
    setTimeout(() => controller.abort(), 50);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });
});
