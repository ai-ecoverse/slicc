export const SCOOP_BOOT_CONCURRENCY = 4;

export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0 || limit <= 0) return;
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}
