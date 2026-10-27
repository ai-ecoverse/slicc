import { corruptValueKey, type QuarantineStorage, replaceStoredValue } from '@slicc/shared-ts';
import type { Account } from '../providers/account-store.js';
import { createLogger } from './logger.js';

const log = createLogger('stored-accounts');

export const ACCOUNTS_KEY = 'slicc_accounts';

export const CORRUPT_ACCOUNTS_KEY = corruptValueKey(ACCOUNTS_KEY);

type StoredRow = Partial<Account> & { providerId: string };

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

export function readStoredAccounts(): Account[] {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  return parseStoredAccounts(raw) ?? [];
}

const holdsCredential = (row: StoredRow): boolean =>
  Boolean(row.apiKey || row.accessToken || row.refreshToken);

function dropsAccountData(previous: StoredRow[], next: StoredRow[]): boolean {
  return previous.some((p) => {
    const n = next.find((row) => row.providerId === p.providerId);
    return !n || (holdsCredential(p) && !holdsCredential(n));
  });
}

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
