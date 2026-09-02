/**
 * Tunables of the `compact-on-idle` experiment: how long a cone must sit
 * idle, and how large its context must be, before a background compaction
 * round starts.
 *
 * Both live in `localStorage` (the page writes them from the experimental
 * settings dialog; the kernel worker reads the same keys through the
 * page→worker storage sync, exactly like the feature-flag overrides). They
 * are read live at every timer arm, so a change applies to the next idle
 * window without a reload.
 */

/** Minutes of idleness before a round starts. */
export const IDLE_COMPACTION_MINUTES_KEY = 'slicc_idle_compaction_minutes';
/** Estimated context tokens a cone must hold before a round is worth it. */
export const IDLE_COMPACTION_MIN_TOKENS_KEY = 'slicc_idle_compaction_min_tokens';

export interface IdleCompactionSettings {
  /** Idle window in minutes. */
  idleMinutes: number;
  /** Minimum estimated context tokens. */
  minTokens: number;
}

export const IDLE_COMPACTION_DEFAULTS: Readonly<IdleCompactionSettings> = Object.freeze({
  idleMinutes: 10,
  minTokens: 50_000,
});

/** Sanity bounds so a typo cannot arm a 0-minute timer or a 0-token gate. */
const MIN_IDLE_MINUTES = 1;
const MIN_TOKENS_FLOOR = 1_000;
/**
 * `setTimeout` takes a 32-bit signed delay; anything larger is clamped to
 * ~1 ms by every runtime, which would turn "practically never" into "right
 * now". Cap the minutes so the largest accepted value still means a very
 * long wait (~24.8 days).
 */
export const MAX_IDLE_MINUTES = Math.floor(2_147_483_647 / 60_000);

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getStorage(): KeyValueStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Partial<KeyValueStorage> }).localStorage;
    if (
      typeof storage?.getItem !== 'function' ||
      typeof storage.setItem !== 'function' ||
      typeof storage.removeItem !== 'function'
    ) {
      return undefined;
    }
    return storage as KeyValueStorage;
  } catch {
    return undefined;
  }
}

function readPositive(key: string, fallback: number, floor: number, ceiling?: number): number {
  const raw = getStorage()?.getItem(key);
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < floor) return fallback;
  return ceiling !== undefined && value > ceiling ? ceiling : value;
}

/** Current settings: stored overrides where valid, defaults otherwise. */
export function readIdleCompactionSettings(): IdleCompactionSettings {
  return {
    idleMinutes: readPositive(
      IDLE_COMPACTION_MINUTES_KEY,
      IDLE_COMPACTION_DEFAULTS.idleMinutes,
      MIN_IDLE_MINUTES,
      MAX_IDLE_MINUTES
    ),
    minTokens: readPositive(
      IDLE_COMPACTION_MIN_TOKENS_KEY,
      IDLE_COMPACTION_DEFAULTS.minTokens,
      MIN_TOKENS_FLOOR
    ),
  };
}

/**
 * Persist an override. A value at or below the floor, or a non-number,
 * clears the override so the default takes over again — the settings
 * dialog maps an emptied field to exactly that.
 */
export function writeIdleCompactionSettings(patch: Partial<IdleCompactionSettings>): void {
  const storage = getStorage();
  if (!storage) return;
  const write = (
    key: string,
    value: number | undefined,
    floor: number,
    ceiling = Number.POSITIVE_INFINITY
  ): void => {
    if (value === undefined || !Number.isFinite(value) || value < floor) storage.removeItem(key);
    else storage.setItem(key, String(Math.min(value, ceiling)));
  };
  try {
    if ('idleMinutes' in patch) {
      write(IDLE_COMPACTION_MINUTES_KEY, patch.idleMinutes, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES);
    }
    if ('minTokens' in patch) {
      write(IDLE_COMPACTION_MIN_TOKENS_KEY, patch.minTokens, MIN_TOKENS_FLOOR);
    }
  } catch {
    // Storage is best-effort; the defaults remain available without it.
  }
}
