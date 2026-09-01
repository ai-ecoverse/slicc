/**
 * Browser-fullscreen a dock-tree surface that is already placed (not parked).
 *
 * Shared by the keyboard `z` command (#2692) and the right-rail long-press
 * gesture: both need the real Fullscreen API against a visible
 * `[surface-id=…]` leaf. A parked surface is `display:none`, and
 * `requestFullscreen()` on a hidden element rejects — so this returns `false`
 * without trying when the leaf is still in `.dock-tree__parking`.
 */

/** Escape a surface id for a double-quoted attribute selector (jsdom lacks CSS.escape). */
function quoteSurfaceId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Request browser fullscreen on the placed surface with `surfaceId`.
 * @returns `true` if a placed surface was found and fullscreen was requested
 *   (the promise may still reject — denial / gesture expiry is swallowed).
 */
export function requestPlacedSurfaceFullscreen(root: ParentNode, surfaceId: string): boolean {
  const surface = root.querySelector<HTMLElement>(`[surface-id="${quoteSurfaceId(surfaceId)}"]`);
  if (!surface || surface.closest('.dock-tree__parking')) return false;
  void surface.requestFullscreen?.()?.catch(() => {
    // Denied, unsupported, or the activation expired — the panel stays open.
  });
  return true;
}
