/**
 * `mount-heartbeat.ts` — progress-aware liveness heartbeat for the shared-FS
 * mount.
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
 * The original beat was TIME-capped (~2 minutes, then silence), which
 * conflated "slow" with "wedged": in the 2026-08-24 field wedge the same
 * repair took ~8 minutes on an I/O-starved disk, outlived the cap, and the
 * watchdog killed a boot that was provably advancing. The beat is now
 * PROGRESS-aware: `work` receives a `tick()` the mount calls per unit of
 * real progress (one sidecar entry probed — see
 * `VirtualFsOptions.onRepairProgress`), and the cap counts consecutive
 * QUIET intervals, not total intervals. While ticks advance, beats flow
 * indefinitely; once ticks stop for {@link MOUNT_HEARTBEAT_MAX_BEATS}
 * intervals in a row the beat goes silent and the watchdog rules again — a
 * genuinely wedged mount (deadlocked web lock, hung OPFS handle) produces
 * no ticks, so it still times out exactly as before.
 */

/** Beat cadence while the mount is in flight. */
export const MOUNT_HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Consecutive tick-less intervals before the heartbeat goes quiet:
 * 24 × 5s ≈ 2 minutes of grace for the mount phases that carry no tick
 * instrumentation (ZenFS sidecar parse, crossCopy), after which a mount
 * that is neither ticking nor finishing is treated as wedged (the page
 * watchdog then fires one timeout-window later). Any tick resets the run.
 */
export const MOUNT_HEARTBEAT_MAX_BEATS = 24;

/**
 * Run `work` while emitting `onProgress` liveness beats
 * (`shared-fs-mount:start`, then `shared-fs-mount:<n>` per interval).
 * `work` receives a `tick()` callback to report fine-grained progress;
 * each interval with at least one new tick resets the quiet run, so an
 * actively-advancing mount beats for as long as it needs. Intervals with
 * no new ticks count against `maxBeats`; once exceeded, beating stops for
 * good. The timer is cleared on resolve AND reject; the work's outcome
 * passes through untouched. With no `onProgress` this is a plain
 * passthrough (the tick is a no-op).
 */
export async function withMountHeartbeat<T>(
  work: (tick: () => void) => Promise<T>,
  onProgress?: (stage: string) => void,
  options: { intervalMs?: number; maxBeats?: number } = {}
): Promise<T> {
  if (!onProgress) return work(() => {});
  const intervalMs = options.intervalMs ?? MOUNT_HEARTBEAT_INTERVAL_MS;
  const maxBeats = options.maxBeats ?? MOUNT_HEARTBEAT_MAX_BEATS;
  onProgress('shared-fs-mount:start');
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
    onProgress(`shared-fs-mount:${beats}`);
  }, intervalMs);
  try {
    return await work(tick);
  } finally {
    clearInterval(timer);
  }
}
