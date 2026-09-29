export function trackInFlight<A extends unknown[], R>(
  fn: (...args: A) => Promise<R> | R,
  delayMs = 5
): { fn: (...args: A) => Promise<R>; stats: { current: number; max: number } } {
  const stats = { current: 0, max: 0 };
  return {
    stats,
    fn: async (...args: A) => {
      stats.current++;
      stats.max = Math.max(stats.max, stats.current);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await fn(...args);
      } finally {
        stats.current--;
      }
    },
  };
}
