/**
 * Per-realm singleton holding the leader tab's mounted `<slicc-permissions>`
 * element.
 *
 * Lives in `base/` (the bottom rung of the layer stack) so every ranked
 * layer can resolve it without importing upward — including `shell/`
 * (`ffmpeg -f avfoundation`). The UI layer owns mounting it
 * (`ui/wc/wc-permissions.ts` is the only setter) and re-exports these
 * accessors for its own callers. `core/permissions-surface-registry.ts`
 * re-exports the same symbols for existing core / speech / kernel /
 * provider imports.
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
