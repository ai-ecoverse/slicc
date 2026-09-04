/**
 * Knobs of the `compact-on-idle` experiment: how long a cone must sit idle,
 * and how large its context must be, before a background compaction round
 * starts.
 *
 * The experimental dialog exposes only the on/off flag — 30 minutes and 200k
 * tokens are the shipped answer and no user is asked to pick numbers. But the
 * numbers ARE readable from `localStorage`, because otherwise the feature is
 * untestable outside a real half-hour wait: an e2e scenario sets an idle
 * window of a second or two and a token floor of nothing, and exercises the
 * same production timer, gates and adoption check the shipped defaults use.
 * The keys were being written already and read by nobody (#2843).
 *
 * Both keys are plain decimal numbers and both are CLAMPED, so a hand-edited
 * or corrupt value degrades to something survivable rather than arming a
 * timer that fires immediately (or in 40 years) against a live conversation.
 */

export interface IdleCompactionSettings {
  /** Idle window in minutes. */
  idleMinutes: number;
  /** Minimum estimated context tokens. */
  minTokens: number;
}

/** Idle minutes and minimum context size for compact-on-idle. */
export const IDLE_COMPACTION_DEFAULTS: Readonly<IdleCompactionSettings> = Object.freeze({
  idleMinutes: 30,
  minTokens: 200_000,
});

/** `localStorage` key overriding {@link IdleCompactionSettings.idleMinutes}. */
export const IDLE_COMPACTION_MINUTES_KEY = 'slicc_idle_compaction_minutes';
/** `localStorage` key overriding {@link IdleCompactionSettings.minTokens}. */
export const IDLE_COMPACTION_MIN_TOKENS_KEY = 'slicc_idle_compaction_min_tokens';

/**
 * Bounds on the idle window. The floor is one hundredth of a minute (600 ms)
 * — small enough for a test to observe a round inside a Playwright budget,
 * large enough that it cannot fire inside the same task that armed it. The
 * ceiling is a day: past `setTimeout`'s 32-bit millisecond limit the runtime
 * clamps the delay to ~1 ms and the timer fires AT ONCE, which is the exact
 * opposite of what a huge number asks for.
 */
const MIN_IDLE_MINUTES = 0.01;
const MAX_IDLE_MINUTES = 24 * 60;
/** A floor of 0 is legitimate: "compact whenever idle, regardless of size". */
const MIN_TOKEN_FLOOR = 0;
const MAX_TOKEN_FLOOR = 10_000_000;

interface ReadOnlyStorage {
  getItem(key: string): string | null;
}

/**
 * The ambient `localStorage`, or `undefined` where there is none. The kernel
 * worker installs a shim, so this resolves in both realms; a float without
 * either simply gets the defaults.
 */
function getStorage(): ReadOnlyStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Partial<ReadOnlyStorage> }).localStorage;
    if (typeof storage?.getItem !== 'function') return undefined;
    return storage as ReadOnlyStorage;
  } catch {
    return undefined;
  }
}

/**
 * A finite number from storage, clamped into `[min, max]`. Anything that is
 * not a finite number (absent, empty, `NaN`, `Infinity`, an object someone
 * stringified) yields `undefined` so the caller keeps its default.
 */
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

/**
 * Current settings: the shipped defaults, with either knob overridden by a
 * clamped `localStorage` value. Read LIVE on every arm and every fire, so a
 * test (or a developer) can change the window without a reload.
 */
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
