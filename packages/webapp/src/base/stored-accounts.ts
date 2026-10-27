/**
 * Raw reader for the `slicc_accounts` localStorage array. Kept in `base/` so
 * `fs/mount/profile.ts` (rank 0) can find the Adobe IMS token without
 * importing `providers/account-store.ts` and its provider/model graph
 * (#3743). `providers/account-store.ts` layers legacy-key cleanup on top and
 * remains the API everything else uses.
 */

import { corruptValueKey, type QuarantineStorage, replaceStoredValue } from '@slicc/shared-ts';
import type { Account } from '../providers/account-store.js';
import { createLogger } from './logger.js';

const log = createLogger('stored-accounts');

/** localStorage key of the JSON account array. */
export const ACCOUNTS_KEY = 'slicc_accounts';

/** Where {@link writeStoredAccounts} copies an unparsable `slicc_accounts` value. */
export const CORRUPT_ACCOUNTS_KEY = corruptValueKey(ACCOUNTS_KEY);

type StoredRow = Partial<Account> & { providerId: string };

/** Rows with a `providerId`; `null` when `raw` is not a JSON array (#4146). */
function parseStoredRows(raw: string): StoredRow[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (entry): entry is StoredRow =>
      entry != null && typeof entry === 'object' && typeof entry.providerId === 'string'
  );
}

function parseStoredAccounts(raw: string): Account[] | null {
  return (
    parseStoredRows(raw)?.filter((row): row is Account => typeof row.apiKey === 'string') ?? null
  );
}

/**
 * Parse the stored accounts, dropping malformed entries; `[]` when absent or
 * unparsable. Save through {@link writeStoredAccounts}, since a save built on
 * that `[]` would otherwise replace every stored provider.
 */
export function readStoredAccounts(): Account[] {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  return parseStoredAccounts(raw) ?? [];
}

const holdsCredential = (row: StoredRow): boolean =>
  Boolean(row.apiKey || row.accessToken || row.refreshToken);

/** Whether `next` deletes a row of `previous` or clears one of its credentials. */
function dropsAccountData(previous: StoredRow[], next: StoredRow[]): boolean {
  return previous.some((p) => {
    const n = next.find((row) => row.providerId === p.providerId);
    return !n || (holdsCredential(p) && !holdsCredential(n));
  });
}

/**
 * The writer for `slicc_accounts` (#4146). An unparsable stored value is
 * copied to {@link CORRUPT_ACCOUNTS_KEY} before `accountsJson` replaces it;
 * if it can't be copied this throws and nothing changes. A save that deletes
 * an account or clears its credentials also drops that copy, since it may
 * still hold them. Absent and parsable values are written as before.
 */
export function writeStoredAccounts(
  accountsJson: string,
  storage: QuarantineStorage = localStorage
): void {
  const before = storage.getItem(ACCOUNTS_KEY);
  if (
    replaceStoredValue(storage, ACCOUNTS_KEY, accountsJson, (raw) => parseStoredRows(raw) !== null)
  ) {
    log.error(
      `Unparsable account store copied to ${CORRUPT_ACCOUNTS_KEY} before saving; accounts saved before this are only in that copy`
    );
    return;
  }
  const previous = before ? parseStoredRows(before) : null;
  if (
    previous &&
    storage.getItem(CORRUPT_ACCOUNTS_KEY) !== null &&
    dropsAccountData(previous, parseStoredRows(accountsJson) ?? [])
  ) {
    storage.removeItem?.(CORRUPT_ACCOUNTS_KEY);
  }
}
