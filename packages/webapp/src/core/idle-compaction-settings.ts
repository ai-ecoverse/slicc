export interface IdleCompactionSettings {
  idleMinutes: number;

  minTokens: number;
}

export const IDLE_COMPACTION_DEFAULTS: Readonly<IdleCompactionSettings> = Object.freeze({
  idleMinutes: 30,
  minTokens: 200_000,
});

export const IDLE_COMPACTION_MINUTES_KEY = 'slicc_idle_compaction_minutes';

export const IDLE_COMPACTION_MIN_TOKENS_KEY = 'slicc_idle_compaction_min_tokens';

const MIN_IDLE_MINUTES = 0.01;
const MAX_IDLE_MINUTES = 24 * 60;

const MIN_TOKEN_FLOOR = 0;
const MAX_TOKEN_FLOOR = 10_000_000;

interface ReadOnlyStorage {
  getItem(key: string): string | null;
}

function getStorage(): ReadOnlyStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Partial<ReadOnlyStorage> }).localStorage;
    if (typeof storage?.getItem !== 'function') return undefined;
    return storage as ReadOnlyStorage;
  } catch {
    return undefined;
  }
}

function readClamped(
  storage: ReadOnlyStorage | undefined,
  key: string,
  min: number,
  max: number
): number | undefined {
  let raw: string | null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return undefined;
  }
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, min), max);
}

export function readIdleCompactionSettings(): IdleCompactionSettings {
  const storage = getStorage();
  return {
    idleMinutes:
      readClamped(storage, IDLE_COMPACTION_MINUTES_KEY, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES) ??
      IDLE_COMPACTION_DEFAULTS.idleMinutes,
    minTokens:
      readClamped(storage, IDLE_COMPACTION_MIN_TOKENS_KEY, MIN_TOKEN_FLOOR, MAX_TOKEN_FLOOR) ??
      IDLE_COMPACTION_DEFAULTS.minTokens,
  };
}
