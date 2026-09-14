export const MOUNT_HEARTBEAT_INTERVAL_MS = 5_000;

export const MOUNT_HEARTBEAT_MAX_BEATS = 24;

export async function withMountHeartbeat<T>(
  work: (tick: () => void) => Promise<T>,
  onProgress?: (stage: string) => void,
  options: { intervalMs?: number; maxBeats?: number; stagePrefix?: string } = {}
): Promise<T> {
  if (!onProgress) return work(() => {});
  const intervalMs = options.intervalMs ?? MOUNT_HEARTBEAT_INTERVAL_MS;
  const maxBeats = options.maxBeats ?? MOUNT_HEARTBEAT_MAX_BEATS;

  const stagePrefix = options.stagePrefix ?? 'shared-fs-mount';
  onProgress(`${stagePrefix}:start`);
  let beats = 0;
  let quietBeats = 0;
  let ticks = 0;
  let seenTicks = 0;
  const tick = (): void => {
    ticks += 1;
  };
  const timer = setInterval(() => {
    if (ticks > seenTicks) {
      seenTicks = ticks;
      quietBeats = 0;
    } else {
      quietBeats += 1;
      if (quietBeats > maxBeats) {
        clearInterval(timer);
        return;
      }
    }
    beats += 1;
    onProgress(`${stagePrefix}:${beats}`);
  }, intervalMs);
  try {
    return await work(tick);
  } finally {
    clearInterval(timer);
  }
}
