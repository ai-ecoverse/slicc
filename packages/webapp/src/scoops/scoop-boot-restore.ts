/**
 * Bounded fan-out for restoring work-unit contexts at boot.
 *
 * `Orchestrator.init()` awaits roots through this helper and lets child
 * restores keep running after `init()` resolves, so lick setup, mount
 * restore, and cone bootstrap do not grow with scoop count. One worker
 * takes the next item only after its previous item settles, and a throw
 * from `fn` rejects the whole batch — callers that must keep going catch
 * per item.
 */

/** How many scoop contexts may initialize at once during boot. */
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
