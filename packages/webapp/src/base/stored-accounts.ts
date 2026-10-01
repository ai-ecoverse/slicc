/**
 * Raw reader for the `slicc_accounts` localStorage array. Kept in `base/` so
 * `fs/mount/profile.ts` (rank 0) can find the Adobe IMS token without
 * importing `providers/account-store.ts` and its provider/model graph
 * (#3743). `providers/account-store.ts` layers legacy-key cleanup on top and
 * remains the API everything else uses.
 */

import type { Account } from '../providers/account-store.js';

/** localStorage key of the JSON account array. */
export const ACCOUNTS_KEY = 'slicc_accounts';

/** Parse the stored accounts, dropping malformed entries; `[]` when absent or unparsable. */
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
