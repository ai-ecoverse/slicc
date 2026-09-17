/**
 * The "Pouring a dip…" card shown where a ```shtml block is still streaming.
 *
 * Mirrors the tool-call row layout (label on the left, pulsing status circle
 * pinned to the right) so the placeholder reads as another in-progress step
 * rather than a separate widget. Reuses the `tool-status-pulse` keyframe and
 * the same orange used by `.tool-call--running` (`styles/dips.css`).
 */
export const DIP_PENDING_PLACEHOLDER =
  '<div class="msg__dip-pending" role="status" aria-live="polite" aria-label="Pouring a dip">' +
  '<span class="msg__dip-pending-label">Pouring a dip…</span>' +
  '<span class="msg__dip-pending-status" aria-hidden="true"></span>' +
  '</div>';
