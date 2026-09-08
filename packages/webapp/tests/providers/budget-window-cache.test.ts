import { describe, expect, it, vi } from 'vitest';
import {
  BUDGET_FAILURE_TTL_MS,
  BUDGET_SUCCESS_TTL_MS,
  BUDGET_UNSUPPORTED_TTL_MS,
  BudgetWindowCache,
} from '../../src/providers/budget-window-cache.js';
import type { ProviderBudgetWindow } from '../../src/providers/provider-budget.js';

const window = (percent: number): ProviderBudgetWindow => ({
  percent,
  status: 'ok',
  window: 'weekly',
});

/** A cache over a controllable clock and a scripted resolver. */
function harness(options: { providerId?: () => string } = {}) {
  let now = 1_000_000;
  const resolve = vi.fn<() => Promise<ProviderBudgetWindow | null>>();
  const cache = new BudgetWindowCache(resolve, options.providerId ?? (() => 'adobe'), () => now);
  return {
    cache,
    resolve,
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

describe('BudgetWindowCache', () => {
  it('fetches once and serves the reading from cache inside the TTL', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(9.5));

    expect(await h.cache.refresh()).toMatchObject({ percent: 9.5 });
    h.advance(BUDGET_SUCCESS_TTL_MS - 1);
    expect(await h.cache.refresh()).toMatchObject({ percent: 9.5 });
    expect(h.resolve).toHaveBeenCalledTimes(1);

    h.advance(1);
    h.resolve.mockResolvedValue(window(11));
    expect(await h.cache.refresh()).toMatchObject({ percent: 11 });
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it('stamps the reading with the instant it was taken', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(9.5));
    const result = await h.cache.refresh();
    expect(result?.at).toBe(h.now);
  });

  it('answers a snapshot with no network, and nothing before the first read', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(9.5));
    expect(h.cache.snapshot()).toBeNull();
    await h.cache.refresh();
    expect(h.cache.snapshot()).toMatchObject({ percent: 9.5 });
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('leaves a provider that reports no window alone for half an hour', async () => {
    // A proxy without the endpoint must not be probed every fifteen seconds
    // for the life of the session.
    const h = harness();
    h.resolve.mockResolvedValue(null);
    expect(await h.cache.refresh()).toBeNull();

    h.advance(BUDGET_SUCCESS_TTL_MS * 5);
    await h.cache.refresh();
    expect(h.resolve).toHaveBeenCalledTimes(1);

    h.advance(BUDGET_UNSUPPORTED_TTL_MS);
    await h.cache.refresh();
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it('retries a FAILED call sooner than an unsupported one, and never rejects', async () => {
    const h = harness();
    h.resolve.mockRejectedValue(new Error('proxy 503'));

    await expect(h.cache.refresh()).resolves.toBeNull();

    h.advance(BUDGET_FAILURE_TTL_MS - 1);
    await h.cache.refresh();
    expect(h.resolve).toHaveBeenCalledTimes(1);

    h.advance(1);
    h.resolve.mockResolvedValue(window(9.5));
    expect(await h.cache.refresh()).toMatchObject({ percent: 9.5 });
  });

  it('keeps the last good reading on screen while the provider is down', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(63));
    await h.cache.refresh();

    h.advance(BUDGET_SUCCESS_TTL_MS);
    h.resolve.mockRejectedValue(new Error('offline'));
    expect(await h.cache.refresh()).toMatchObject({ percent: 63 });
    expect(h.cache.snapshot()).toMatchObject({ percent: 63 });
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const h = harness();
    let release: (w: ProviderBudgetWindow) => void = () => {};
    h.resolve.mockReturnValue(
      new Promise<ProviderBudgetWindow>((resolve) => {
        release = resolve;
      })
    );

    const both = Promise.all([h.cache.refresh(), h.cache.refresh()]);
    release(window(42));
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it('re-probes immediately when the account changed under it', async () => {
    // The previous provider's allowance is not a stale reading of this one —
    // it is a reading of something else.
    let providerId = 'adobe';
    const h = harness({ providerId: () => providerId });
    h.resolve.mockResolvedValue(window(63));
    await h.cache.refresh();

    providerId = 'anthropic';
    expect(h.cache.snapshot()).toBeNull();
    expect(h.cache.isStale()).toBe(true);

    h.resolve.mockResolvedValue(null);
    expect(await h.cache.refresh()).toBeNull();
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it('forces a fetch inside the TTL when asked', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(9.5));
    await h.cache.refresh();
    await h.cache.refresh({ force: true });
    expect(h.resolve).toHaveBeenCalledTimes(2);
  });

  it('forgets everything on clear()', async () => {
    const h = harness();
    h.resolve.mockResolvedValue(window(9.5));
    await h.cache.refresh();
    h.cache.clear();
    expect(h.cache.snapshot()).toBeNull();
    expect(h.cache.isStale()).toBe(true);
  });
});
