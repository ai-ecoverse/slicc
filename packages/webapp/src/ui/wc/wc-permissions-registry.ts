/**
 * Per-realm singleton holding the leader tab's mounted `<slicc-permissions>`
 * element. Mirrors the shared-registry pattern used by `getSharedUsbRegistry`
 * / `getSharedHidRegistry` / `getSharedSerialRegistry` so page-realm callers
 * (panel-RPC handlers, future terminal/composer/mount migrations) can locate
 * the surface without reaching into the WC shell or a bare global.
 *
 * `installLeaderPermissionsSurface` is the only setter — it registers the
 * element on mount and clears it on dispose. Returns `null` when no leader
 * surface is mounted (cherry follower mode, pre-boot, or after dispose).
 */

import type { SliccPermissions } from '@slicc/webcomponents';

let leaderSurface: SliccPermissions | null = null;

/** Currently mounted leader permissions surface, or `null` when none. */
export function getLeaderPermissionsSurface(): SliccPermissions | null {
  return leaderSurface;
}

/**
 * Register the leader surface. Passing `null` clears the registry.
 * Idempotent — passing the same element twice is a no-op.
 */
export function setLeaderPermissionsSurface(element: SliccPermissions | null): void {
  leaderSurface = element;
}
