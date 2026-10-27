/**
 * Keep a present-but-unreadable `localStorage` value when a writer replaces
 * it (#4146). The JSON stores in `slicc_accounts` and
 * `slicc_oauth_extra_domains` are read-modify-written as a whole and their
 * readers report an unreadable value as empty, so the next save would
 * otherwise overwrite every entry the unreadable value still held.
 */

export interface QuarantineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional so a get/set-only fake still works; the stores use it to drop their copy. */
  removeItem?(key: string): void;
}

/** Where the unreadable value of `key` is kept. Only the newest copy survives. */
export function corruptValueKey(key: string): string {
  return `${key}.corrupt`;
}

/**
 * Write `value` to `key`. When `key` holds a value `isReadable` rejects, copy
 * it to {@link corruptValueKey} first, replacing an older copy. `key` is only
 * replaced after that copy is stored, and a `setItem` that throws leaves the
 * previous value in place, so the original is never held nowhere: if the
 * copy can't be stored this throws and saves nothing, and if the replacement
 * throws, `key` still holds the original next to its copy.
 *
 * Returns whether an unreadable value was copied aside.
 */
export function replaceStoredValue(
  storage: QuarantineStorage,
  key: string,
  value: string,
  isReadable: (raw: string) => boolean
): boolean {
  const raw = storage.getItem(key);
  const unreadable = raw !== null && raw !== '' && !isReadable(raw);
  if (unreadable) {
    const target = corruptValueKey(key);
    try {
      storage.setItem(target, raw);
    } catch {
      throw new Error(
        storage.getItem(key) === raw
          ? `${key} is unreadable and could not be backed up to ${target}, so nothing was saved and ${key} was left as it was. Free some browser storage for this site and try again.`
          : `${key} changed while it was being backed up, so nothing was saved. Try again.`
      );
    }
  }
  storage.setItem(key, value);
  return unreadable;
}
