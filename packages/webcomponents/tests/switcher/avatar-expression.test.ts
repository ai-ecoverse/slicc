import { describe, expect, it } from 'vitest';
import {
  approach,
  BASE_BROWS,
  bottomLidY,
  chordHalfWidth,
  DEFAULT_DROWSE_DELAY_S,
  DROWSE_END_LID,
  DROWSE_RAMP_S,
  DROWSE_START_LID,
  drowseLid,
  EYE_R,
  fillToPupilScale,
  isLeftRaised,
  LID_OVERSHOOT,
  nextGazeIndex,
  POP_MS,
  PUPIL_MIN_FRACTION,
  parseActivity,
  parseDrowseDelay,
  popScale,
  pupilRx,
  recockBrows,
  SOCKET_MIN_RX,
  shapeTargetFor,
  socketRx,
  topLidY,
  travelClamp,
} from '../../src/switcher/avatar-expression.js';

/** A deterministic stand-in for Math.random that cycles a fixed sequence. */
function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] as number;
}

describe('avatar-expression', () => {
  it('treats an absent activity as "no engine" and an unknown one as idle', () => {
    expect(parseActivity(null)).toBeNull();
    expect(parseActivity('thinking')).toBe('thinking');
    expect(parseActivity('awaiting')).toBe('awaiting');
    expect(parseActivity('nonsense')).toBe('idle');
    expect(parseActivity('')).toBe('idle');
  });

  it('falls back to the 90 s drowse delay for junk and negative values', () => {
    expect(parseDrowseDelay(null)).toBe(DEFAULT_DROWSE_DELAY_S);
    expect(parseDrowseDelay('abc')).toBe(DEFAULT_DROWSE_DELAY_S);
    expect(parseDrowseDelay('-4')).toBe(DEFAULT_DROWSE_DELAY_S);
    expect(parseDrowseDelay('0')).toBe(0);
    expect(parseDrowseDelay('12.5')).toBe(12.5);
  });

  it('squares up only for a running tool call', () => {
    expect(shapeTargetFor('working')).toBe(1);
    for (const activity of ['idle', 'thinking', 'awaiting', null] as const) {
      expect(shapeTargetFor(activity)).toBe(0);
    }
  });

  it('maps the shape scalar onto socket and pupil corner radii', () => {
    expect(socketRx(0)).toBe(EYE_R);
    expect(socketRx(1)).toBe(SOCKET_MIN_RX);
    expect(socketRx(0.5)).toBeCloseTo((EYE_R + SOCKET_MIN_RX) / 2, 5);
    expect(pupilRx(18, 0)).toBe(18);
    expect(pupilRx(18, 1)).toBeCloseTo(18 * PUPIL_MIN_FRACTION, 5);
  });

  it('keeps pupil travel clamped to a circle even in a square socket', () => {
    expect(travelClamp(18)).toBe(16);
    expect(travelClamp(30)).toBe(4);
    // Never collapses to zero: a huge pupil still gets a sliver of travel.
    expect(travelClamp(40)).toBe(2);
  });

  it('scales the pupil with context fill on the documented three-part ramp', () => {
    expect(fillToPupilScale(0)).toBe(1);
    expect(fillToPupilScale(50)).toBe(1);
    expect(fillToPupilScale(85)).toBe(2.2);
    expect(fillToPupilScale(100)).toBe(2.2);
    expect(fillToPupilScale(67.5)).toBeCloseTo(1.6, 5);
  });

  it('parks an open lid off the socket and cuts across it once engaged', () => {
    expect(topLidY(0)).toBe(50 - EYE_R - LID_OVERSHOOT);
    expect(bottomLidY(0)).toBe(50 + EYE_R + LID_OVERSHOOT);
    expect(topLidY(0.5)).toBe(50);
    expect(bottomLidY(0.5)).toBe(50);
    expect(topLidY(0.38)).toBeCloseTo(50 - EYE_R + 0.38 * 2 * EYE_R, 5);
  });

  it('widens the chord toward the flat edge as the socket squares up', () => {
    // A cut through the centre spans the full diameter on a circle.
    expect(chordHalfWidth(50, 0)).toBeCloseTo(EYE_R, 5);
    // Off-centre cuts are shorter on a circle, but not on a square.
    expect(chordHalfWidth(20, 0)).toBeLessThan(EYE_R);
    expect(chordHalfWidth(20, 1)).toBeCloseTo(EYE_R - 2, 5);
    expect(chordHalfWidth(20, 0.5)).toBeGreaterThan(chordHalfWidth(20, 0));
  });

  it('holds the soft awaiting lid until the delay, then ramps to the settled cut', () => {
    expect(drowseLid(0, 90)).toBe(DROWSE_START_LID);
    expect(drowseLid(89, 90)).toBe(DROWSE_START_LID);
    expect(drowseLid(90 + DROWSE_RAMP_S / 2, 90)).toBeCloseTo(
      (DROWSE_START_LID + DROWSE_END_LID) / 2,
      5
    );
    expect(drowseLid(90 + DROWSE_RAMP_S, 90)).toBe(DROWSE_END_LID);
    expect(drowseLid(9000, 90)).toBe(DROWSE_END_LID);
  });

  it('decays the pupil pop over its transient window', () => {
    expect(popScale(POP_MS)).toBeCloseTo(1.16, 5);
    expect(popScale(POP_MS / 2)).toBeCloseTo(1.08, 5);
    expect(popScale(0)).toBe(1);
    expect(popScale(-100)).toBe(1);
  });

  it('re-cocks the brows: the raised side flips on the roll, constants re-jitter', () => {
    expect(isLeftRaised(BASE_BROWS)).toBe(true);
    // First roll under the flip chance → the raised side swaps to the right.
    const flipped = recockBrows(BASE_BROWS, sequence([0.1, 0.5, 0.5, 0.5, 0.5]));
    expect(isLeftRaised(flipped)).toBe(false);
    expect(flipped.right.raise).toBeLessThan(0);
    expect(flipped.left.raise).toBeGreaterThan(0);

    // First roll above the flip chance → the same side stays raised, re-jittered.
    const held = recockBrows(BASE_BROWS, sequence([0.9, 0.2, 0.8, 0.4, 0.6]));
    expect(isLeftRaised(held)).toBe(true);
    expect(held.left.raise).not.toBe(BASE_BROWS.left.raise);
    // The left brow mirrors: its raised tilt is negative (inner end up).
    expect(held.left.tilt).toBeLessThan(0);
    expect(held.right.raise).toBeGreaterThan(0);
  });

  it('keeps every re-cocked pose inside the documented jitter envelope', () => {
    for (let roll = 0; roll < 20; roll += 1) {
      const pose = recockBrows(BASE_BROWS, Math.random);
      const raised = isLeftRaised(pose) ? pose.left : pose.right;
      const settled = isLeftRaised(pose) ? pose.right : pose.left;
      expect(Math.abs(raised.raise)).toBeGreaterThanOrEqual(7);
      expect(Math.abs(raised.raise)).toBeLessThanOrEqual(12);
      expect(Math.abs(raised.tilt)).toBeGreaterThanOrEqual(7);
      expect(Math.abs(raised.tilt)).toBeLessThanOrEqual(12);
      expect(Math.abs(settled.raise)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(settled.raise)).toBeLessThanOrEqual(3);
      expect(Math.abs(settled.tilt)).toBeGreaterThanOrEqual(4);
      expect(Math.abs(settled.tilt)).toBeLessThanOrEqual(7);
    }
  });

  it('never picks the gaze target it is already looking at', () => {
    for (let index = 0; index < 5; index += 1) {
      for (let roll = 0; roll < 10; roll += 1) {
        expect(nextGazeIndex(index, 5, () => roll / 10)).not.toBe(index);
      }
    }
    expect(nextGazeIndex(0, 1, Math.random)).toBe(0);
  });

  it('eases proportionally and never overshoots on a long frame', () => {
    expect(approach(0, 1, 6, 1 / 60)).toBeCloseTo(0.1, 5);
    expect(approach(0, 1, 6, 10)).toBe(1);
    expect(approach(0.5, 0.5, 6, 1 / 60)).toBe(0.5);
  });
});
