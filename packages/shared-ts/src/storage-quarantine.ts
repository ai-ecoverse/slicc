export interface QuarantineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;

  removeItem?(key: string): void;
}

export function corruptValueKey(key: string): string {
  return `${key}.corrupt`;
}

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
