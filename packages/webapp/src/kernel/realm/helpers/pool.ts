export type PoolFn = <T, R>(
  concurrency: number,
  items: ReadonlyArray<T>,
  fn: (item: T, index: number) => Promise<R> | R
) => Promise<R[]>;

export const pool: PoolFn = async <T, R>(
  concurrency: number,
  items: ReadonlyArray<T>,
  fn: (item: T, index: number) => Promise<R> | R
): Promise<R[]> => {
  const n = Math.max(1, Math.trunc(concurrency) || 1);
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  for (let w = 0; w < Math.min(n, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
};
