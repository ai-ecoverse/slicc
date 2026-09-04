/**
 * When the browser window this runtime lives in was last loaded.
 *
 * `uptime` has to answer "how long has the system been up", and in a browser
 * the system is the page: a reload is a reboot. Every realm can read
 * `performance.timeOrigin`, but in the kernel worker that is when the WORKER
 * was constructed, which is some way into the page's boot — so the page hands
 * its own origin over in `kernel-worker-init` and the worker records it here.
 *
 * Sits in `base/` for the same reason `slicc-version.ts` and `tray-role.ts`
 * do: `shell/` reads it without importing up the layer stack.
 */

let pageLoadedAt: number | null = null;

/**
 * Record the page realm's `performance.timeOrigin`. Called once by the kernel
 * worker's boot from the init message; pass `null` to clear (tests, teardown).
 */
export function setPageLoadedAt(epochMs: number | null): void {
  pageLoadedAt = epochMs !== null && Number.isFinite(epochMs) && epochMs > 0 ? epochMs : null;
}

/**
 * Epoch ms of the last page load.
 *
 * Falls back to this realm's own `performance.timeOrigin` when nothing was
 * registered — correct in the page realm (where it IS the page's origin) and
 * the closest available answer anywhere else. `Date.now()` is the last resort
 * for a realm with no `performance`, which reports an uptime of zero rather
 * than a wrong one.
 */
export function readPageLoadedAt(): number {
  if (pageLoadedAt !== null) return pageLoadedAt;
  const origin = globalThis.performance?.timeOrigin;
  return typeof origin === 'number' && Number.isFinite(origin) && origin > 0 ? origin : Date.now();
}
