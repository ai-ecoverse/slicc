import type { ProviderBudgetWindow } from './provider-budget.js';

export const BUDGET_SUCCESS_TTL_MS = 60_000;

export const BUDGET_FAILURE_TTL_MS = 5 * 60_000;

export const BUDGET_UNSUPPORTED_TTL_MS = 30 * 60_000;

type ProbeOutcome = 'ok' | 'unsupported' | 'failed';

interface CacheEntry {
  outcome: ProbeOutcome;
  window: ProviderBudgetWindow | null;
  at: number;
}

export type BudgetWindowResolver = () => Promise<ProviderBudgetWindow | null>;

export type ProviderIdResolver = () => string;

export class BudgetWindowCache {
  #entry: CacheEntry | null = null;
  #entryProviderId: string | null = null;
  #inFlight: Promise<ProviderBudgetWindow | null> | null = null;
  #inFlightProviderId: string | null = null;

  constructor(
    private readonly resolve: BudgetWindowResolver,
    private readonly providerId: ProviderIdResolver,
    private readonly now: () => number = Date.now
  ) {}

  #ttl(outcome: ProbeOutcome): number {
    if (outcome === 'ok') return BUDGET_SUCCESS_TTL_MS;
    if (outcome === 'unsupported') return BUDGET_UNSUPPORTED_TTL_MS;
    return BUDGET_FAILURE_TTL_MS;
  }

  isStale(): boolean {
    const entry = this.#entry;

    if (!entry || this.#entryProviderId !== this.providerId()) return true;
    return this.now() - entry.at >= this.#ttl(entry.outcome);
  }

  snapshot(): ProviderBudgetWindow | null {
    if (this.#entryProviderId !== this.providerId()) return null;
    return this.#entry?.window ?? null;
  }

  async refresh(opts: { force?: boolean } = {}): Promise<ProviderBudgetWindow | null> {
    if (!opts.force && !this.isStale()) return this.snapshot();
    const providerId = this.providerId();

    if (this.#inFlight !== null && this.#inFlightProviderId === providerId) return this.#inFlight;
    this.#inFlight = this.resolve()
      .then((window) => {
        const stamped = window ? { ...window, at: this.now() } : null;
        this.#record(providerId, stamped ? 'ok' : 'unsupported', stamped);
        return stamped;
      })
      .catch(() => {
        const previous = this.snapshot();
        this.#record(providerId, 'failed', previous);
        return previous;
      })
      .finally(() => {
        if (this.#inFlightProviderId === providerId) {
          this.#inFlight = null;
          this.#inFlightProviderId = null;
        }
      });
    this.#inFlightProviderId = providerId;
    return this.#inFlight;
  }

  #record(providerId: string, outcome: ProbeOutcome, window: ProviderBudgetWindow | null): void {
    if (providerId !== this.providerId()) return;
    this.#entryProviderId = providerId;
    this.#entry = { outcome, window, at: this.now() };
  }

  clear(): void {
    this.#entry = null;
    this.#entryProviderId = null;
  }
}
