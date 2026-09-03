/**
 * Track user `setTimeout` / `setInterval` so the JS realm can keep-alive
 * the way Node does: the process stays up while libuv still has ref'd
 * handles (timers, I/O), not because the entry script's returned promise
 * is pending.
 *
 * A bare `new Promise(() => {})` is NOT a handle — Node exits, and so do
 * we. RPC-backed I/O is counted separately via `RealmRpcClient.pendingCount`.
 *
 * Wrapping happens on the supplied global (default `globalThis`) and must
 * be restored when the realm finishes: the in-process test factory shares
 * an isolate with vitest.
 */

type TimerId = ReturnType<typeof setTimeout>;
type IntervalId = ReturnType<typeof setInterval>;
type TimerCallback = (...args: unknown[]) => void;

export interface TimerHandleTracker {
  readonly pendingCount: number;
  install(): void;
  restore(): void;
  /** Cancel pending timers without running their callbacks (`process.exit`). */
  clearPending(): void;
  /** Uncounted macrotask hop for the drain loop's own first tick. */
  tick(): Promise<void>;
  /**
   * Resolve on the next fire/clear (or immediately when nothing is pending)
   * so the drain can sleep until a handle actually changes instead of
   * spinning `setTimeout(0)`.
   */
  waitForProgress(): Promise<void>;
}

export function createTimerHandleTracker(
  g: typeof globalThis = globalThis,
  options?: { onCallbackError?: (err: unknown) => void }
): TimerHandleTracker {
  const originalSetTimeout = g.setTimeout;
  const originalClearTimeout = g.clearTimeout;
  const originalSetInterval = g.setInterval;
  const originalClearInterval = g.clearInterval;
  const nativeSetTimeout = originalSetTimeout.bind(g) as typeof setTimeout;
  const nativeClearTimeout = originalClearTimeout.bind(g) as typeof clearTimeout;
  const nativeSetInterval = originalSetInterval.bind(g) as typeof setInterval;
  const nativeClearInterval = originalClearInterval.bind(g) as typeof clearInterval;

  const timeouts = new Set<TimerId>();
  const intervals = new Set<IntervalId>();
  const progressWaiters = new Set<() => void>();
  let installed = false;

  const notifyProgress = (): void => {
    if (progressWaiters.size === 0) return;
    const waiters = [...progressWaiters];
    progressWaiters.clear();
    for (const waiter of waiters) waiter();
  };

  const forget = (id: TimerId | IntervalId | undefined | null): boolean => {
    if (id === undefined || id === null) return false;
    const hadTimeout = timeouts.delete(id);
    const hadInterval = intervals.delete(id);
    return hadTimeout || hadInterval;
  };

  const runCallback = (handler: TimerCallback, args: unknown[]): void => {
    try {
      handler(...args);
    } catch (err) {
      options?.onCallbackError?.(err);
      if (!options?.onCallbackError) throw err;
    } finally {
      notifyProgress();
    }
  };

  return {
    get pendingCount() {
      return timeouts.size + intervals.size;
    },

    install() {
      if (installed) return;
      installed = true;

      g.setTimeout = ((handler: TimerCallback | string, delay?: number, ...args: unknown[]) => {
        if (typeof handler !== 'function') {
          return nativeSetTimeout(handler, delay, ...(args as []));
        }
        const id: TimerId = nativeSetTimeout(() => {
          timeouts.delete(id);
          runCallback(handler, args);
        }, delay);
        timeouts.add(id);
        return id;
      }) as typeof setTimeout;

      g.clearTimeout = ((id?: TimerId) => {
        const had = forget(id);
        nativeClearTimeout(id as TimerId);
        if (had) notifyProgress();
      }) as typeof clearTimeout;

      g.setInterval = ((handler: TimerCallback | string, delay?: number, ...args: unknown[]) => {
        if (typeof handler !== 'function') {
          return nativeSetInterval(handler, delay, ...(args as []));
        }
        const id: IntervalId = nativeSetInterval(() => {
          runCallback(handler, args);
        }, delay);
        intervals.add(id);
        return id;
      }) as typeof setInterval;

      g.clearInterval = ((id?: IntervalId) => {
        const had = forget(id);
        nativeClearInterval(id as IntervalId);
        if (had) notifyProgress();
      }) as typeof clearInterval;
    },

    restore() {
      if (!installed) return;
      installed = false;
      g.setTimeout = originalSetTimeout;
      g.clearTimeout = originalClearTimeout;
      g.setInterval = originalSetInterval;
      g.clearInterval = originalClearInterval;
    },

    clearPending() {
      for (const id of timeouts) nativeClearTimeout(id);
      timeouts.clear();
      for (const id of intervals) nativeClearInterval(id);
      intervals.clear();
      notifyProgress();
    },

    tick() {
      return new Promise<void>((resolve) => {
        nativeSetTimeout(resolve, 0);
      });
    },

    waitForProgress() {
      if (timeouts.size + intervals.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        progressWaiters.add(resolve);
      });
    },
  };
}
