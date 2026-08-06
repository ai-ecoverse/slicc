/**
 * Per-realm singleton holding the leader tab's mounted `<slicc-permissions>`
 * element.
 *
 * Lives in `core/` rather than `ui/` because the callers that need a
 * gesture-gated surface sit BELOW the UI layer — the OAuth launcher
 * (`providers/`), speech capture (`speech/`), and the remote terminal view
 * (`kernel/`). Keeping the registry here lets them resolve the surface
 * without importing upward into `ui/`. The UI layer owns mounting it
 * (`ui/wc/wc-permissions.ts` is the only setter) and re-exports these
 * accessors for its own callers.
 *
 * Returns `null` when no leader surface is mounted (cherry follower mode,
 * pre-boot, or after dispose).
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
