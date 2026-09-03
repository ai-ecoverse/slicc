/**
 * Fixed knobs of the `compact-on-idle` experiment: how long a cone must sit
 * idle, and how large its context must be, before a background compaction
 * round starts. Not user-tunable — the experimental dialog only exposes the
 * on/off flag.
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

/** Current settings (fixed; kept as a function so call sites can stay injectable in tests). */
export function readIdleCompactionSettings(): IdleCompactionSettings {
  return IDLE_COMPACTION_DEFAULTS;
}
