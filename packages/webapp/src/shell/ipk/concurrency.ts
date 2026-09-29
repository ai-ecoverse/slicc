export const DEFAULT_FETCH_CONCURRENCY = 8;

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active--;
    queue.shift()?.();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++;
        task().then(resolve, reject).finally(release);
      };
      if (active < max) start();
      else queue.push(start);
    });
}

export async function allSettledOrThrow<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
