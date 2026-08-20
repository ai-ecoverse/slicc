import { describe, expect, it } from 'vitest';
import {
  AMBIENT_FPS,
  AMBIENT_FRAME_MS,
  advanceFrameTs,
  BURST_MS,
  FRAME_EPSILON_MS,
  shouldRender,
} from '../../src/freezer/frame-budget.js';

/** Simulate a rAF host ticking at `hz` for `seconds`, counting admitted frames. */
function simulate(hz: number, seconds: number, energetic: boolean): number {
  let last = Number.NEGATIVE_INFINITY;
  let renders = 0;
  const ticks = Math.floor(hz * seconds);
  for (let i = 0; i < ticks; i++) {
    const now = i * (1000 / hz);
    if (shouldRender(now, last, energetic)) {
      last = advanceFrameTs(now, last, energetic);
      renders++;
    }
  }
  return renders;
}

describe('frame-budget', () => {
  it('exposes the tuned constants', () => {
    expect(AMBIENT_FPS).toBe(15);
    expect(AMBIENT_FRAME_MS).toBeCloseTo(1000 / 15, 5);
    expect(BURST_MS).toBe(800);
    expect(FRAME_EPSILON_MS).toBe(4);
  });

  it('admits ~15 fps from a 60 Hz host', () => {
    const renders = simulate(60, 1, false);
    expect(renders).toBeGreaterThanOrEqual(14);
    expect(renders).toBeLessThanOrEqual(16);
  });

  it('admits ~15 fps from a 120 Hz host (epsilon absorbs jitter)', () => {
    const renders = simulate(120, 1, false);
    expect(renders).toBeGreaterThanOrEqual(14);
    expect(renders).toBeLessThanOrEqual(16);
  });

  it('admits every frame while energetic', () => {
    expect(simulate(60, 1, true)).toBe(60);
  });

  it('always admits the first frame', () => {
    expect(shouldRender(0, Number.NEGATIVE_INFINITY, false)).toBe(true);
  });

  it('advances on the ambient grid to avoid drift', () => {
    // Render at t=0, then a jittery tick at 68ms: the grid advance keeps the
    // next deadline anchored at 66.67+66.67, not 68+66.67.
    const afterFirst = advanceFrameTs(0, Number.NEGATIVE_INFINITY, false);
    expect(afterFirst).toBe(0);
    const afterSecond = advanceFrameTs(68, afterFirst, false);
    expect(afterSecond).toBeCloseTo(AMBIENT_FRAME_MS, 5);
  });

  it('snaps to now after a long stall instead of fast-forwarding', () => {
    // Hidden tab for 5s: one frame on resume, no catch-up burst.
    expect(advanceFrameTs(5000, 0, false)).toBe(5000);
  });

  it('takes nowTs verbatim for energetic frames', () => {
    expect(advanceFrameTs(123.4, 100, true)).toBe(123.4);
  });
});
