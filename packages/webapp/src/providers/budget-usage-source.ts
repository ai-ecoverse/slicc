import { getSelectedProvider } from './account-store.js';
import { BudgetWindowCache } from './budget-window-cache.js';
import { getRegisteredProviderConfig } from './index.js';
import type { ProviderBudgetWindow } from './provider-budget.js';

async function resolveActiveBudgetWindow(): Promise<ProviderBudgetWindow | null> {
  const providerId = getSelectedProvider();
  if (!providerId) return null;
  const config = getRegisteredProviderConfig(providerId);
  if (!config?.getBudgetUsage) return null;
  const window = await config.getBudgetUsage();
  return window ? { ...window, providerId } : null;
}

function activeProviderId(): string {
  try {
    return getSelectedProvider();
  } catch {
    return '';
  }
}

const cache = new BudgetWindowCache(resolveActiveBudgetWindow, activeProviderId);

export function getBudgetWindowSnapshot(): ProviderBudgetWindow | null {
  return cache.snapshot();
}

export function refreshBudgetWindow(opts?: {
  force?: boolean;
}): Promise<ProviderBudgetWindow | null> {
  return cache.refresh(opts);
}

export function isBudgetWindowStale(): boolean {
  return cache.isStale();
}

export function clearBudgetWindowCache(): void {
  cache.clear();
}
