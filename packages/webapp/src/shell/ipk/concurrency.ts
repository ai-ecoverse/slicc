/**
 * Bounded concurrency for ipk's network work.
 *
 * Packuments and tarballs are fetched through limiters so a large tree
 * overlaps its round trips (the research report measured express@^4 going
 * from 4.8 s to 1.4 s this way) without opening an unbounded number of
 * requests or holding every tarball in memory at once.
 */

/** Default for both packument and tarball fetches, as pnpm's prototype used. */
export const DEFAULT_FETCH_CONCURRENCY = 8;

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Run at most `limit` tasks at a time; the rest wait in FIFO order. */
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

/**
 * Await every promise, then rethrow the first rejection (in array order).
 * Unlike `Promise.all`, nothing is still running when this settles, so a
 * failed install cannot keep writing after it has reported the error.
 */
export async function allSettledOrThrow<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}
