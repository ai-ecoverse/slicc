/**
 * The one place the running SLICC build identity is read.
 *
 * `__SLICC_VERSION__` / `__SLICC_RELEASED_AT__` / `__SLICC_BUILD_ID__` are Vite
 * `define`s baked from the root `package.json` (see
 * `packages/webapp/vite.config.ts` and `packages/chrome-extension/vite.config.ts`)
 * — the same version the upgrade lick compares. This module sits in `base/` so
 * every layer above it can read the build identity without a back-edge:
 * `scoops/upgrade-detection.ts` (the lick), `shell/supplemental-commands/`
 * (`uname -r`, `upgrade status`), and the JS realm's `SLICC_VERSION` global.
 */

export interface SliccVersion {
  /** Semantic version of the running build, e.g. `6.66.1`. */
  version: string;
  /** Release timestamp when the release pipeline supplied one, else null. */
  releasedAt: string | null;
  /** Per-build stamp, `<version>-<base36 build time>`. No commit sha is baked. */
  buildId: string;
}

export function readSliccVersion(): SliccVersion {
  return {
    version: __SLICC_VERSION__,
    releasedAt: __SLICC_RELEASED_AT__,
    buildId: __SLICC_BUILD_ID__,
  };
}

/**
 * localStorage mirror of the "last seen version" marker that
 * `scoops/upgrade-detection.ts` keeps in IndexedDB.
 *
 * The marker itself is scoops-owned state, and the shell sits below scoops in
 * the layer stack — so `upgrade status` reads this mirror rather than inverting
 * the stack to reach the store. Same mechanism the tray status/follower shims
 * use: the page writes it, and the kernel worker sees it via the boot-time
 * `localStorageSeed` plus `installPageStorageSync`'s live forwarding.
 */
export const LAST_SEEN_VERSION_STORAGE_KEY = 'slicc.lastSeenVersion';

/** Read the mirror. `null` when absent, empty, or storage is unavailable. */
export function readLastSeenVersionFromShim(): string | null {
  try {
    const value = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      LAST_SEEN_VERSION_STORAGE_KEY
    );
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Best-effort mirror write — a missing localStorage or a quota error is ignored. */
export function writeLastSeenVersionToShim(version: string): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(
      LAST_SEEN_VERSION_STORAGE_KEY,
      version
    );
  } catch {
    // best-effort mirror
  }
}
