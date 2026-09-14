export interface InflightLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;

  readonly active: number;
}

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
