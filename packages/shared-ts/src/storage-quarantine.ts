/**
 * Preserve a present-but-unparsable `localStorage` value before a writer
 * replaces it (#4146). The JSON stores in `slicc_accounts` and
 * `slicc_oauth_extra_domains` are read-modify-written as a whole and their
 * readers report an unparsable value as empty, so the next save would
 * otherwise overwrite every entry the corrupt value still held.
 */

export interface QuarantineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional so a get/set-only fake still works; without it a full store cannot be preserved. */
  removeItem?(key: string): void;
}

/** Where the corrupt value of `key` is kept. Only the newest copy survives. */
export function corruptValueKey(key: string): string {
  return `${key}.corrupt`;
}

function isQuotaError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22;
}

/**
 * Copy `raw`, the current value of `key`, to {@link corruptValueKey}. A full
 * store (plausibly why `key` went bad) gets a move instead of a copy: the
 * original is removed to make room and written back if the copy still fails.
 * Returns false when `raw` could not be preserved; `key` then still holds it
 * and the caller must not overwrite `key`.
 */
export function quarantineCorruptValue(
  storage: QuarantineStorage,
  key: string,
  raw: string
): boolean {
  const target = corruptValueKey(key);
  try {
    storage.setItem(target, raw);
    return true;
  } catch (err) {
    if (!isQuotaError(err)) return false;
  }
  if (!storage.removeItem) return false;
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  try {
    storage.setItem(target, raw);
    return true;
  } catch {
    try {
      storage.setItem(key, raw);
    } catch {
      // The slot was freed a moment ago, so this only fails if another tab filled it.
    }
    return false;
  }
}
