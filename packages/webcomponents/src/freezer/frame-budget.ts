/**
 * Frame budget for decorative animation loops.
 *
 * Ambient decorative motion renders at AMBIENT_FPS; interactive stimuli
 * (pulse, attribute changes, theme flips, resizes) open a BURST_MS window at
 * full display rate so direct responses stay crisp. Pure and DOM-free so the
 * gating math is unit-testable without rAF timing.
 *
 * Rule of thumb (see docs/webcomponents-details.md "Animation loops"): a
 * background field whose fastest visible component is well under 1 Hz —
 * slicc-shader's is sin(t*2.7) ≈ 0.43 Hz — is ~35x oversampled at 15 fps.
 */

/** Ambient cadence for decorative fields. */
export const AMBIENT_FPS = 15;
export const AMBIENT_FRAME_MS = 1000 / AMBIENT_FPS;
/** Full-rate window opened by an interactive stimulus. */
export const BURST_MS = 800;
/**
 * Scheduling jitter allowance. Without it a 60 Hz host (16.67 ms ticks)
 * arrives just under each 66.67 ms deadline and slips a whole tick late,
 * sagging the effective rate toward 12 fps.
 */
export const FRAME_EPSILON_MS = 4;

/**
 * Decide whether a rAF tick at `nowTs` should render. `energetic` means a
 * burst window is open or pulse energy is still decaying.
 */
export function shouldRender(nowTs: number, lastFrameTs: number, energetic: boolean): boolean {
  if (energetic) return true;
  return nowTs - lastFrameTs >= AMBIENT_FRAME_MS - FRAME_EPSILON_MS;
}

/**
 * Advance the last-frame timestamp after a render. Ambient frames advance on
 * the 15 fps grid (keeps the long-run average exactly at budget despite rAF
 * jitter); a stall of more than one interval (hidden tab) snaps to `nowTs` so
 * resume does not fast-forward. Energetic frames and the first frame
 * (lastFrameTs = -Infinity) take `nowTs` verbatim.
 */
export function advanceFrameTs(nowTs: number, lastFrameTs: number, energetic: boolean): number {
  if (energetic || !Number.isFinite(lastFrameTs)) return nowTs;
  const gridNext = lastFrameTs + AMBIENT_FRAME_MS;
  return nowTs - gridNext > AMBIENT_FRAME_MS ? nowTs : gridNext;
}
