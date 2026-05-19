/**
 * Throttled-error tracking for the per-interval target-refresh paths
 * in `page-leader-tray.ts` and `page-follower-tray.ts`.
 *
 * Both file's periodic refresh observed identical needs:
 *   - log at `error` level (prod gate is ERROR by default)
 *   - throttle to at most one log per 60 s during a sustained failure
 *   - emit a symmetric recovery signal once the failure clears, so an
 *     operator can see "MTTR" rather than silence
 *   - require a debounce window of consecutive successes before
 *     declaring recovery — so rapid fail/succeed flapping doesn't
 *     keep resetting the throttle and busting the 1/min ceiling
 *   - use `performance.now()` (monotonic) so NTP backward jumps
 *     can't cause indefinite suppression
 *
 * This module centralizes that logic so the two call sites can't
 * drift, and so the contract can be unit-tested in isolation.
 */

import type { Logger } from '../core/logger.js';

interface ThrottledErrorTrackerOptions {
  /** Message logged on a throttled failure (passed through `log.error`). */
  failureMessage: string;
  /** Message logged on the first recovery tick after the debounce window. */
  recoveryMessage: string;
  /** Throttle gate — only log a failure if this many ms have elapsed since the last log. Default 60 s. */
  throttleMs?: number;
  /** How many consecutive successes are required before declaring recovery. Default 5 ticks. */
  recoveryDebounceTicks?: number;
  /** Clock injection seam for testing. Default `performance.now()`. */
  now?: () => number;
}

export class ThrottledErrorTracker {
  private readonly logger: Logger;
  private readonly failureMessage: string;
  private readonly recoveryMessage: string;
  private readonly throttleMs: number;
  private readonly recoveryDebounceTicks: number;
  private readonly now: () => number;

  // `-Infinity` (NOT 0): `performance.now()` is small-valued at process
  // start, so an initial `0` would make the first
  // `now - lastErrorLogAt > throttleMs` check FALSE and suppress the
  // very first error log. `-Infinity` guarantees the first failure
  // passes through.
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;
  private inFailingState = false;
  private consecutiveSuccesses = 0;

  constructor(logger: Logger, opts: ThrottledErrorTrackerOptions) {
    // Validate at construction so silent suppression bugs (NaN
    // throttle, float debounce, empty message) surface immediately
    // rather than only on the first failure. The `-Infinity` initial
    // state has its own dedicated comment further down because it's
    // not validatable here.
    if (!opts.failureMessage.trim()) {
      throw new RangeError('ThrottledErrorTracker: failureMessage must be non-empty');
    }
    if (!opts.recoveryMessage.trim()) {
      throw new RangeError('ThrottledErrorTracker: recoveryMessage must be non-empty');
    }
    const throttleMs = opts.throttleMs ?? 60_000;
    if (!Number.isFinite(throttleMs) || throttleMs < 0) {
      throw new RangeError(
        `ThrottledErrorTracker: throttleMs must be a non-negative finite number, got ${throttleMs}`
      );
    }
    const recoveryDebounceTicks = opts.recoveryDebounceTicks ?? 5;
    if (!Number.isInteger(recoveryDebounceTicks) || recoveryDebounceTicks < 1) {
      throw new RangeError(
        `ThrottledErrorTracker: recoveryDebounceTicks must be a positive integer, got ${recoveryDebounceTicks}`
      );
    }
    this.logger = logger;
    this.failureMessage = opts.failureMessage;
    this.recoveryMessage = opts.recoveryMessage;
    this.throttleMs = throttleMs;
    this.recoveryDebounceTicks = recoveryDebounceTicks;
    this.now = opts.now ?? (() => performance.now());
  }

  /** Called on each refresh failure. Emits `log.error` at most once per `throttleMs`. */
  reportFailure(error: unknown): void {
    this.inFailingState = true;
    this.consecutiveSuccesses = 0;
    const now = this.now();
    if (now - this.lastErrorLogAt > this.throttleMs) {
      // Throttle counter commit goes in `finally` so a double-throw
      // (logger AND fallback console both fail) still advances the
      // counter — otherwise a permanently-broken log path would
      // disarm the throttle indefinitely, and every subsequent
      // failure would re-attempt the failing log on a tight loop.
      try {
        try {
          this.logger.error(this.failureMessage, {
            error: error instanceof Error ? error.message : String(error),
          });
        } catch (logErr) {
          // Fallback so the operator has at least one signal of the
          // underlying failure AND the logger fault. Wrapped in its
          // own try so a console.error throw (DOMException with
          // cyclic detail, extension-context-invalidated) doesn't
          // skip the throttle commit.
          try {
            console.error('[throttled-error-tracker] logger.error threw', logErr, {
              originalMessage: this.failureMessage,
              originalError: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Both log paths failed; there is nothing more we can do.
          }
        }
      } finally {
        this.lastErrorLogAt = now;
      }
    }
  }

  /** Called on each refresh success. Emits the recovery log on the first tick that crosses the debounce window. */
  reportSuccess(): void {
    if (!this.inFailingState) return;
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses < this.recoveryDebounceTicks) return;
    // Reset state in `finally` so even a double-throw (logger AND
    // fallback both fail) doesn't leave the tracker stuck in failing
    // state. Without finally, the counter would keep incrementing on
    // every reportSuccess (already incremented above) and the block
    // would re-enter and re-attempt the failing log every tick.
    try {
      try {
        // `error` (not `info`) because the prod log gate is ERROR. The
        // recovery signal is only useful if it actually reaches the
        // same operator surface as the failure signal.
        this.logger.error(this.recoveryMessage, { kind: 'recovery' });
      } catch (logErr) {
        try {
          console.error('[throttled-error-tracker] logger.error (recovery) threw', logErr, {
            originalMessage: this.recoveryMessage,
          });
        } catch {
          // Both log paths failed.
        }
      }
    } finally {
      this.inFailingState = false;
      this.consecutiveSuccesses = 0;
      this.lastErrorLogAt = Number.NEGATIVE_INFINITY;
    }
  }
}
