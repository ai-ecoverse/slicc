/**
 * The one place the app asks "is this provider on a rolling budget, and how
 * much of it is gone?".
 *
 * The kernel facade (session stats → floatbar + monitor) and the `cost`
 * command's registered provider both read through this module, so the pill,
 * the panel and the terminal can never show three different windows.
 *
 * Worker-resident and DOM-free, like the account store it reads. The `cost`
 * command reaches it through the orchestrator's registered provider rather
 * than importing it, so no supplemental command pulls the provider registry
 * into the eagerly-evaluated boot closure the first-load gate measures.
 */

import { getSelectedProvider } from './account-store.js';
import { BudgetWindowCache } from './budget-window-cache.js';
import { getRegisteredProviderConfig } from './index.js';
import type { ProviderBudgetWindow } from './provider-budget.js';

/**
 * Ask the SELECTED provider for its window.
 *
 * The cone's selected provider owns the reading: a budget is an account-wide
 * allowance, not a per-scoop one, and a scoop that borrowed another model of
 * the same provider is still spending the same window.
 *
 * Returns `null` for "this provider has no budget concept" (no hook, no
 * account, nothing reported). THROWS when a supported provider's call failed,
 * so the cache can tell a proxy that lacks the endpoint from one that was
 * briefly unreachable and retry them on different clocks.
 */
async function resolveActiveBudgetWindow(): Promise<ProviderBudgetWindow | null> {
  const providerId = getSelectedProvider();
  if (!providerId) return null;
  const config = getRegisteredProviderConfig(providerId);
  if (!config?.getBudgetUsage) return null;
  const window = await config.getBudgetUsage();
  return window ? { ...window, providerId } : null;
}

/**
 * Reading the selected provider defensively: this runs on every staleness
 * check, including in a cold worker whose account store has not been seeded,
 * where the lookup can throw rather than answer.
 */
function activeProviderId(): string {
  try {
    return getSelectedProvider();
  } catch {
    return '';
  }
}

const cache = new BudgetWindowCache(resolveActiveBudgetWindow, activeProviderId);

/** The last good window, with no network. Safe on a request loop. */
export function getBudgetWindowSnapshot(): ProviderBudgetWindow | null {
  return cache.snapshot();
}

/** Fetch when stale (see {@link BudgetWindowCache}); never rejects. */
export function refreshBudgetWindow(opts?: {
  force?: boolean;
}): Promise<ProviderBudgetWindow | null> {
  return cache.refresh(opts);
}

/** Whether a {@link refreshBudgetWindow} call would hit the network. */
export function isBudgetWindowStale(): boolean {
  return cache.isStale();
}

/** Forget the reading — exposed for tests and account teardown. */
export function clearBudgetWindowCache(): void {
  cache.clear();
}
