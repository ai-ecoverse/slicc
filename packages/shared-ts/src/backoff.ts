/**
 * Capped exponential backoff, in one place.
 *
 * The delay formula `Math.min(baseMs * 2 ** attempt, capMs)` was hand-rolled
 * nine-plus times across the three floats and webapp internals (CDP reconnect,
 * kernel realm HTTP retry, scoop turn-runner, jshd supervisor, follower model
 * surface, extension side panel, electron/lick reconnect). The copies drifted
 * on base, cap, jitter, and the attempt-exponent clamp — and the storm-hardening
 * (jitter + exponent clamp) added for the CDP reconnect never reached the rest.
 *
 * `nextBackoffDelayMs` is the single definition. `nextCdpReconnectDelayMs`
 * (jitter + exponent clamp + injectable `random` for tests) was the most
 * complete copy and is the template; each site now passes its own
 * `baseMs`/`capMs` instead of re-deriving the formula.
 */

export interface BackoffOptions {
  /**
   * How many failures have already been recorded, `0` = the gap after the
   * first failure. Clamped to `>= 0`; fractional values are used as-is.
   */
  attempt: number;
  /** Delay for `attempt === 0`, before any doubling. */
  baseMs: number;
  /**
   * Upper bound on the returned delay (jitter included). Omit for an uncapped
   * `baseMs * 2 ** attempt` — matches the sites that never clamped.
   */
  capMs?: number;
  /**
   * Fraction of the exponential delay added as random jitter, in `[0, 1]`.
   * Default `0` (no jitter). The jittered delay still respects `capMs`.
   */
  jitter?: number;
  /**
   * Clamp the exponent so `2 ** shift` cannot overflow after a long failure
   * streak. Omit to leave the exponent unbounded (uncapped callers rely on
   * `capMs` or a bounded `attempt` instead).
   */
  maxShift?: number;
  /** Returns a value in `[0, 1)`; injectable so tests can pin the jitter. */
  random?: () => number;
}

/**
 * Delay before the next retry. With no `capMs`/`maxShift`/`jitter` this is
 * exactly `baseMs * 2 ** attempt`; adding them layers on the storm-hardening.
 */
export function nextBackoffDelayMs({
  attempt,
  baseMs,
  capMs,
  jitter = 0,
  maxShift,
  random = Math.random,
}: BackoffOptions): number {
  let shift = Math.max(0, attempt);
  if (maxShift !== undefined) shift = Math.min(shift, maxShift);
  const exp = baseMs * 2 ** shift;
  const capped = capMs === undefined ? exp : Math.min(capMs, exp);
  if (jitter <= 0) return capped;
  const withJitter = capped + Math.round(capped * jitter * random());
  return capMs === undefined ? withJitter : Math.min(capMs, withJitter);
}
