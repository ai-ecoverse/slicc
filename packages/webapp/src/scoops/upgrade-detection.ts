/**
 * Upgrade detection — compares the bundled SLICC version (baked into the
 * webapp/extension bundle at build time as `__SLICC_VERSION__` from the
 * root `package.json`) against the version recorded in IndexedDB during
 * the previous boot.
 *
 * On version change, the caller (ui/main.ts, chrome-extension offscreen)
 * emits an `upgrade` lick to the cone. The upgrade skill can then surface
 * a changelog and offer a three-way merge of bundled vfs-root content
 * into the user's workspace.
 */

import { getState, setState } from './db.js';

const LAST_SEEN_STATE_KEY = 'slicc:last-seen-version';

export interface BundledVersion {
  version: string;
  releasedAt: string | null;
}

export interface UpgradeDetection {
  bundled: BundledVersion;
  /** null on first boot; previously recorded version otherwise. */
  lastSeen: string | null;
  /** True when bundled.version differs from lastSeen. */
  isUpgrade: boolean;
}

/**
 * Return the bundled SLICC version baked into this build. Sourced from the
 * root `package.json` via Vite `define` in `packages/webapp/vite.config.ts`
 * and `packages/chrome-extension/vite.config.ts`.
 */
export function readBundledVersion(): BundledVersion {
  return {
    version: __SLICC_VERSION__,
    releasedAt: __SLICC_RELEASED_AT__,
  };
}

export async function getLastSeenVersion(): Promise<string | null> {
  const raw = await getState(LAST_SEEN_STATE_KEY);
  // Treat both nullish and empty-string as "no recorded version" so the
  // marker can be cleared by writing an empty string in tests/dev tools.
  return raw && raw.length > 0 ? raw : null;
}

export async function setLastSeenVersion(version: string): Promise<void> {
  await setState(LAST_SEEN_STATE_KEY, version);
}

/**
 * Detect upgrades against the previously-stored "last seen" version.
 *
 * IMPORTANT: This function does **not** advance the marker for the
 * upgrade case. The caller is responsible for invoking
 * {@link recordVersionSeen} only after the upgrade lick has actually
 * been routed to a target (i.e., after a cone exists). Otherwise the
 * lick can be silently dropped while the marker is already advanced,
 * permanently losing the upgrade notification for that version.
 *
 * Behavior matrix:
 *   - lastSeen is null (first boot) → record bundled silently, do not
 *     fire lick (the caller has nothing to route).
 *   - lastSeen === bundled → no change, no lick, no record.
 *   - lastSeen !== bundled → upgrade detected; caller MUST call
 *     {@link recordVersionSeen} after routing the lick.
 */
export async function detectUpgrade(): Promise<UpgradeDetection> {
  const bundled = readBundledVersion();
  const lastSeen = await getLastSeenVersion();

  if (lastSeen === null) {
    // First boot — record silently. There is no prior version to upgrade
    // FROM, so the lick has nothing meaningful to say.
    await setLastSeenVersion(bundled.version);
    return { bundled, lastSeen: null, isUpgrade: false };
  }

  if (lastSeen === bundled.version) {
    return { bundled, lastSeen, isUpgrade: false };
  }

  // Genuine upgrade — DO NOT advance the marker here. Let the caller
  // record the new version only after the lick has been routed.
  return { bundled, lastSeen, isUpgrade: true };
}

/**
 * Persist the bundled version as "seen" once the upgrade lick has
 * actually been delivered to a target. Pairs with {@link detectUpgrade}
 * to avoid losing upgrade notifications when no cone exists at the
 * moment detection runs.
 */
export async function recordVersionSeen(version: string): Promise<void> {
  await setLastSeenVersion(version);
}

export const __test__ = {
  LAST_SEEN_STATE_KEY,
};
