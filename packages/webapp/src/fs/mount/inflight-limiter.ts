/**
 * A minimal in-flight limiter (counting semaphore over promises).
 *
 * Mount backends that talk to a local bridge fan out hard: isomorphic-git's
 * `statusMatrix` fires one `Promise.all` per tree level, so a mid-sized repo
 * queues thousands of `fetch()` calls at once. The browser only opens ~6
 * sockets per origin, so the rest sit in the connection queue for seconds —
 * long enough for the server to close a pooled keep-alive socket underneath a
 * request that is about to reuse it (`TypeError: Failed to fetch`). Capping
 * the number of concurrent requests keeps the queue shallow and the sockets
 * hot, which removes most of that window (the retry in the caller covers the
 * rest).
 */

export interface InflightLimiter {
  /** Run `fn` once a slot is free; releases the slot when it settles. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Currently executing (not queued) calls — test/diagnostic access. */
  readonly active: number;
}

/**
 * @param max Maximum concurrent calls. Values < 1 are clamped to 1; a
 *   non-finite value disables limiting.
 */
export function createInflightLimiter(max: number): InflightLimiter {
  if (!Number.isFinite(max)) {
    return {
      run: (fn) => fn(),
      get active() {
        return 0;
      },
    };
  }
  const limit = Math.max(1, Math.floor(max));
  const waiters: Array<() => void> = [];
  let active = 0;

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active -= 1;
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
  };
}
