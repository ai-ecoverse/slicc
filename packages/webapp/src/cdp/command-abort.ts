/**
 * Cooperative cancellation for a browser command whose caller gave up.
 *
 * Its own module rather than part of `browser-api.ts` because `har-recorder.ts`
 * needs the same boundary and `browser-api.ts` imports the recorder — putting
 * the error there would make the two files circular. Nothing here touches CDP:
 * it is `AbortSignal`, timers and promises.
 */

import type { AbortWaiter } from './pending-request-table.js';

/**
 * The caller gave up on this command before it finished.
 *
 * Raised when the `signal` handed to `BrowserAPI.withTab` fires — the agent's bash tool hit `background_after` or
 * the turn was cancelled, so nobody is left to read the result. Cancellation
 * is COOPERATIVE and lands at three kinds of boundary: while queued for a
 * lock, at a page-driven wait (`Page.loadEventFired`, a `waitForSelector`
 * poll), and between CDP round trips.
 *
 * **A round trip already on the wire is not cancellable.** CDP has no "cancel
 * request" verb, so the send in flight when the signal fires still completes
 * (or times out) and may still have been applied to the page; what abort
 * guarantees is that nothing AFTER it is started, and that the tab's lock is
 * released as soon as that step returns. `step` names where the command
 * stopped so the caller's stderr can say so.
 */
export class CommandAbortedError extends Error {
  override readonly name = 'CommandAbortedError';

  constructor(readonly step: string) {
    super(
      `Browser command aborted while ${step}. A CDP round trip already in flight cannot be ` +
        'cancelled, so it may still have been applied to the page; nothing after it was started.'
    );
  }
}

/** Reject at a cancellation boundary when `signal` has already fired. */
export function throwIfAborted(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted) throw new CommandAbortedError(step);
}

/** {@link AbortWaiter} for `signal`, rejecting a wait with the step it stopped at. */
export function abortWaiter(
  signal: AbortSignal | undefined,
  step: string
): AbortWaiter | undefined {
  return signal ? { signal, error: () => new CommandAbortedError(step) } : undefined;
}

/**
 * Sleep `ms`, rejecting early when `signal` fires.
 *
 * The timer is cleared on abort so an abandoned poll loop leaves nothing
 * pending — a bare `setTimeout` race would keep the tab's interval alive for
 * its full duration after the caller is gone.
 */
export function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
  step: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CommandAbortedError(step));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CommandAbortedError(step));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wait for `queued` (a lock chain) unless `signal` fires first.
 *
 * Rejecting does NOT hand the lock on: the caller stays in the FIFO chain and
 * releases its slot only once its predecessor really finishes (see
 * `BrowserAPI`'s tab-lock chain), or a successor would start while the
 * current holder is still driving the tab.
 */
export function raceAbort(
  queued: Promise<void>,
  signal: AbortSignal | undefined,
  step: string
): Promise<void> {
  if (!signal) return queued;
  if (signal.aborted) return Promise.reject(new CommandAbortedError(step));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new CommandAbortedError(step));
    signal.addEventListener('abort', onAbort, { once: true });
    queued.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
