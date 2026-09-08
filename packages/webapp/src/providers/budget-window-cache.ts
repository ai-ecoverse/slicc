/**
 * The rolling-budget reading every surface shares, and the cache in front of
 * it.
 *
 * `GET /v1/usage` is a network call on a provider that may not implement it
 * at all, while the readers — the 15s session-stats poll, the monitor, the
 * `cost` command — ask far more often than a 7-day window can move. So the
 * fetch sits behind a cache with three different memories:
 *
 *   - a **success** is good for a minute (the window moves in hours),
 *   - a **failure** is retried in five (offline, 5xx, an expired token),
 *   - an **unsupported** provider is left alone for half an hour — a proxy
 *     without the endpoint must not be probed every fifteen seconds for the
 *     life of the session.
 *
 * Readers get a SYNCHRONOUS snapshot ({@link BudgetWindowCache.snapshot}) and
 * kick the refresh off separately, because the session-stats reply sits on the
 * request loop and must never wait on a provider's network.
 */

import type { ProviderBudgetWindow } from './provider-budget.js';

/** How long a good reading stands before the next fetch. */
export const BUDGET_SUCCESS_TTL_MS = 60_000;
/** How long to wait after a failed fetch. */
export const BUDGET_FAILURE_TTL_MS = 5 * 60_000;
/** How long to leave a provider alone once it reports no window at all. */
export const BUDGET_UNSUPPORTED_TTL_MS = 30 * 60_000;

/** What one provider probe answered. */
type ProbeOutcome = 'ok' | 'unsupported' | 'failed';

interface CacheEntry {
  outcome: ProbeOutcome;
  window: ProviderBudgetWindow | null;
  at: number;
}

/**
 * Resolves the active provider's window. Returns `null` when the provider has
 * no budget concept; THROWS when the call itself failed, which is a different
 * fact and earns a different retry delay.
 */
export type BudgetWindowResolver = () => Promise<ProviderBudgetWindow | null>;

/** Names the account a reading belongs to — the cache key. */
export type ProviderIdResolver = () => string;

export class BudgetWindowCache {
  #entry: CacheEntry | null = null;
  #entryProviderId: string | null = null;
  #inFlight: Promise<ProviderBudgetWindow | null> | null = null;

  constructor(
    private readonly resolve: BudgetWindowResolver,
    private readonly providerId: ProviderIdResolver,
    private readonly now: () => number = Date.now
  ) {}

  /** How long the current entry stands, by what it recorded. */
  #ttl(outcome: ProbeOutcome): number {
    if (outcome === 'ok') return BUDGET_SUCCESS_TTL_MS;
    if (outcome === 'unsupported') return BUDGET_UNSUPPORTED_TTL_MS;
    return BUDGET_FAILURE_TTL_MS;
  }

  /** Whether a fetch would run right now (public so callers can skip work). */
  isStale(): boolean {
    const entry = this.#entry;
    // A switched account invalidates immediately, whatever the TTL says: the
    // previous provider's allowance is not a stale reading of this one, it is
    // a reading of something else.
    if (!entry || this.#entryProviderId !== this.providerId()) return true;
    return this.now() - entry.at >= this.#ttl(entry.outcome);
  }

  /**
   * The last good reading, without touching the network. `null` when nothing
   * has been read yet or when the provider reported no window.
   */
  snapshot(): ProviderBudgetWindow | null {
    if (this.#entryProviderId !== this.providerId()) return null;
    return this.#entry?.window ?? null;
  }

  /**
   * Fetch when the entry is stale, otherwise answer from cache. Concurrent
   * callers share one in-flight probe; a rejection is never re-thrown at the
   * reader — a decorative counter must not fail a request loop — it is
   * recorded as a failure and answered with the previous reading.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<ProviderBudgetWindow | null> {
    if (!opts.force && !this.isStale()) return this.snapshot();
    if (this.#inFlight !== null) return this.#inFlight;
    const providerId = this.providerId();
    this.#inFlight = this.resolve()
      .then((window) => {
        const stamped = window ? { ...window, at: this.now() } : null;
        this.#record(providerId, stamped ? 'ok' : 'unsupported', stamped);
        return stamped;
      })
      .catch(() => {
        // Keep whatever we last knew: a window that was 63% a minute ago is a
        // better answer than a blank pill while the proxy is briefly down.
        const previous = this.snapshot();
        this.#record(providerId, 'failed', previous);
        return previous;
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  #record(providerId: string, outcome: ProbeOutcome, window: ProviderBudgetWindow | null): void {
    this.#entryProviderId = providerId;
    this.#entry = { outcome, window, at: this.now() };
  }

  /** Forget everything. */
  clear(): void {
    this.#entry = null;
    this.#entryProviderId = null;
  }
}
