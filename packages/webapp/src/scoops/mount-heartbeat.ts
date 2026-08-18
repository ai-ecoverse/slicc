/**
 * `mount-heartbeat.ts` — bounded liveness heartbeat for the shared-FS mount.
 *
 * The OPFS mount is the one boot phase with no natural milestones: ZenFS
 * parses the multi-megabyte metadata sidecar and the unconditional pre-boot
 * repair (#2146/#2148) probes every sidecar entry against the real OPFS
 * tree. On a large tree (22k entries in the 2026-08-18 field incident) a
 * COLD boot — fresh Chrome, no OPFS caches — spends 25-30s+ in that phase
 * in silence, which blows the page's 30s kernel-ready watchdog (#2007):
 * the leader bricked with "Kernel worker did not signal ready within
 * 30000ms" on every restart, while a warm reload squeaked under the limit.
 *
 * The watchdog is a STALL detector, so the beat must not run forever — a
 * genuinely wedged mount (deadlocked web lock, hung OPFS handle) has to
 * stop beating and let the timeout fire. Hence the cap: up to
 * {@link MOUNT_HEARTBEAT_MAX_BEATS} interval beats (~2 minutes of mount
 * grace), then silence, and the watchdog rules again.
 */

/** Beat cadence while the mount is in flight. */
export const MOUNT_HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Beats before the heartbeat goes quiet: 24 × 5s ≈ 2 minutes of grace for
 * an O(tree) mount, after which a still-pending mount is treated as wedged
 * (the page watchdog then fires one timeout-window later).
 */
export const MOUNT_HEARTBEAT_MAX_BEATS = 24;

/**
 * Run `work` while emitting `onProgress` liveness beats
 * (`shared-fs-mount:start`, then `shared-fs-mount:<n>` per interval, capped
 * at {@link MOUNT_HEARTBEAT_MAX_BEATS}). The timer is cleared on resolve
 * AND reject; the work's outcome passes through untouched. With no
 * `onProgress` this is a plain passthrough.
 */
export async function withMountHeartbeat<T>(
  work: () => Promise<T>,
  onProgress?: (stage: string) => void,
  options: { intervalMs?: number; maxBeats?: number } = {}
): Promise<T> {
  if (!onProgress) return work();
  const intervalMs = options.intervalMs ?? MOUNT_HEARTBEAT_INTERVAL_MS;
  const maxBeats = options.maxBeats ?? MOUNT_HEARTBEAT_MAX_BEATS;
  onProgress('shared-fs-mount:start');
  let beats = 0;
  const timer = setInterval(() => {
    beats += 1;
    if (beats > maxBeats) {
      clearInterval(timer);
      return;
    }
    onProgress(`shared-fs-mount:${beats}`);
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
