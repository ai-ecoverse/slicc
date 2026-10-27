/**
 * Raw reader for the `slicc_accounts` localStorage array. Kept in `base/` so
 * `fs/mount/profile.ts` (rank 0) can find the Adobe IMS token without
 * importing `providers/account-store.ts` and its provider/model graph
 * (#3743). `providers/account-store.ts` layers legacy-key cleanup on top and
 * remains the API everything else uses.
 */

import { corruptValueKey, type QuarantineStorage, quarantineCorruptValue } from '@slicc/shared-ts';
import type { Account } from '../providers/account-store.js';
import { createLogger } from './logger.js';

const log = createLogger('stored-accounts');

/** localStorage key of the JSON account array. */
export const ACCOUNTS_KEY = 'slicc_accounts';

/** Where {@link preserveCorruptAccounts} moves an unparsable `slicc_accounts` value. */
export const CORRUPT_ACCOUNTS_KEY = corruptValueKey(ACCOUNTS_KEY);

/** `null` when `raw` is not a JSON array: a value nothing may overwrite unpreserved (#4146). */
function parseStoredAccounts(raw: string): Account[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(
    (entry): entry is Account =>
      entry != null &&
      typeof entry === 'object' &&
      typeof entry.providerId === 'string' &&
      typeof entry.apiKey === 'string'
  );
}

/**
 * Parse the stored accounts, dropping malformed entries; `[]` when absent or
 * unparsable. Writers must call {@link preserveCorruptAccounts} first, since
 * a save built on that `[]` would replace every stored provider.
 */
export function readStoredAccounts(): Account[] {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (!raw) return [];
  return parseStoredAccounts(raw) ?? [];
}

/**
 * Run before anything replaces `slicc_accounts`: when the stored value is
 * unparsable, move it to {@link CORRUPT_ACCOUNTS_KEY} (replacing an older
 * copy) so the save can go ahead without destroying the keys and OAuth masks
 * it may still hold (#4146). Throws, leaving the value in place, when it
 * cannot be preserved. Absent and parsable values are left alone.
 */
export function preserveCorruptAccounts(storage: QuarantineStorage = localStorage): void {
  const raw = storage.getItem(ACCOUNTS_KEY);
  if (!raw || parseStoredAccounts(raw) !== null) return;
  if (!quarantineCorruptValue(storage, ACCOUNTS_KEY, raw)) {
    log.error('Unparsable account store could not be preserved; refusing to overwrite it', {
      chars: raw.length,
    });
    throw new Error(
      `The saved provider accounts (${ACCOUNTS_KEY}) are unreadable and could not be backed up, so nothing was saved. Free some browser storage for this site and try again.`
    );
  }
  log.error(
    `Unparsable account store moved to ${CORRUPT_ACCOUNTS_KEY}; accounts saved before this are only in that copy`,
    { chars: raw.length }
  );
}
