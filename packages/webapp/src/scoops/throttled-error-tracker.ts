import type { Logger } from '../base/logger.js';

interface ThrottledErrorTrackerOptions {
  failureMessage: string;

  recoveryMessage: string;

  throttleMs?: number;

  sustainedRelogMs?: number;

  recoveryDebounceTicks?: number;

  now?: () => number;
}

export class ThrottledErrorTracker {
  private readonly logger: Logger;
  private readonly failureMessage: string;
  private readonly recoveryMessage: string;
  private readonly throttleMs: number;
  private readonly sustainedRelogMs: number;
  private readonly recoveryDebounceTicks: number;
  private readonly now: () => number;

  private lastErrorLogAt = Number.NEGATIVE_INFINITY;
  private inFailingState = false;
  private consecutiveSuccesses = 0;

  constructor(logger: Logger, opts: ThrottledErrorTrackerOptions) {
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
    const sustainedRelogMs = opts.sustainedRelogMs ?? 300_000;
    if (!Number.isFinite(sustainedRelogMs) || sustainedRelogMs < 0) {
      throw new RangeError(
        `ThrottledErrorTracker: sustainedRelogMs must be a non-negative finite number, got ${sustainedRelogMs}`
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
    this.sustainedRelogMs = sustainedRelogMs;
    this.recoveryDebounceTicks = recoveryDebounceTicks;
    this.now = opts.now ?? (() => performance.now());
  }

  reportFailure(error: unknown): void {
    const wasAlreadyFailing = this.inFailingState;
    this.inFailingState = true;
    this.consecutiveSuccesses = 0;
    const now = this.now();
    const elapsed = now - this.lastErrorLogAt;

    const cadence = wasAlreadyFailing ? this.sustainedRelogMs : this.throttleMs;
    if (elapsed > cadence) {
      const sustained = wasAlreadyFailing;
      const message = sustained ? `${this.failureMessage} (sustained)` : this.failureMessage;
      try {
        try {
          this.logger.error(
            message,
            sustained
              ? {
                  error: error instanceof Error ? error.message : String(error),
                  elapsedMs: Math.round(elapsed),
                }
              : {
                  error: error instanceof Error ? error.message : String(error),
                }
          );
        } catch (logErr) {
          try {
            console.error('[throttled-error-tracker] logger.error threw', logErr, {
              originalMessage: message,
              originalError: error instanceof Error ? error.message : String(error),
            });
          } catch {}
        }
      } finally {
        this.lastErrorLogAt = now;
      }
    }
  }

  reportSuccess(): void {
    if (!this.inFailingState) return;
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses < this.recoveryDebounceTicks) return;

    try {
      try {
        this.logger.error(this.recoveryMessage, { kind: 'recovery' });
      } catch (logErr) {
        try {
          console.error('[throttled-error-tracker] logger.error (recovery) threw', logErr, {
            originalMessage: this.recoveryMessage,
          });
        } catch {}
      }
    } finally {
      this.inFailingState = false;
      this.consecutiveSuccesses = 0;
      this.lastErrorLogAt = Number.NEGATIVE_INFINITY;
    }
  }
}
