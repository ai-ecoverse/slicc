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
 * The "last seen version" marker — the version this profile booted last time —
 * lives in IndexedDB and is owned by `scoops/upgrade-detection.ts`. The shell
 * sits BELOW scoops in the layer stack, so `upgrade status` cannot import that
 * reader directly. Instead the kernel host (which already owns upgrade
 * detection) registers one here at boot, the same way it publishes the
 * ProcessManager and LickManager for shell commands.
 *
 * Registration is synchronous and happens during `createKernelHost`, before
 * any shell exists, so there is no window in which a command sees a
 * half-initialized marker. The reader itself hits IndexedDB on demand, so it
 * always reflects the CURRENT marker rather than a snapshot — including after
 * `recordVersionSeen` advances it mid-session.
 */
export type LastSeenVersionReader = () => Promise<string | null>;

let lastSeenVersionReader: LastSeenVersionReader | null = null;

/** Publish the marker reader. Pass `null` to unregister (tests, teardown). */
export function setLastSeenVersionReader(reader: LastSeenVersionReader | null): void {
  lastSeenVersionReader = reader;
}

/**
 * The registered marker reader, or `null` in a runtime that never wired one
 * (a bare unit-test shell). Callers must report that as "unknown" rather than
 * as "no version recorded" — the two are different answers.
 */
export function getLastSeenVersionReader(): LastSeenVersionReader | null {
  return lastSeenVersionReader;
}
