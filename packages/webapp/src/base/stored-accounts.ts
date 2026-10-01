import type { Account } from '../providers/account-store.js';

export const ACCOUNTS_KEY = 'slicc_accounts';

export function readStoredAccounts(): Account[] {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Account =>
        entry != null &&
        typeof entry === 'object' &&
        typeof entry.providerId === 'string' &&
        typeof entry.apiKey === 'string'
    );
  } catch {
    return [];
  }
}
