import { describe, expect, it } from 'vitest';
import vectors from '../../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/expression-vectors.json' with {
  type: 'json',
};
import {
  ANCHOR_EASE,
  approach,
  BASE_BROWS,
  BLINK_APEX_MS,
  BLINK_SQUISH,
  BROW_HALF_WIDTH,
  BROW_STROKE,
  BROW_Y,
  bottomLidY,
  chordHalfWidth,
  DEFAULT_DROWSE_DELAY_S,
  DROWSE_END_LID,
  DROWSE_RAMP_S,
  DROWSE_START_LID,
  drowseLid,
  EYE_CY,
  EYE_R,
  fillToPupilScale,
  GLOWER_LID,
  GLOWER_MS,
  LEFT_CX,
  LID_EASE,
  LID_LINE_EPSILON,
  LID_OVERSHOOT,
  MAX_OFFSET,
  nextGazeIndex,
  POP_GAIN,
  POP_MS,
  PUPIL_MIN_FRACTION,
  PUPIL_R,
  parseActivity,
  popScale,
  pupilRx,
  RECOCK_FLIP_CHANCE,
  REST_GAZE,
  RIGHT_CX,
  recockBrows,
  SACCADE_EASE,
  SACCADE_INTERVAL_MS,
  SACCADE_TARGETS,
  SCRUTINY_LID,
  SCRUTINY_MS,
  SHAPE_EASE,
  SOCKET_MIN_RX,
  shapeTargetFor,
  socketRx,
  topLidY,
  travelClamp,
  WANDER_EASE,
  WANDER_INTERVAL_MS,
  WANDER_TARGETS,
} from '../../src/switcher/avatar-expression.js';

/** A deterministic stand-in for Math.random that walks a fixed sequence. */
function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] as number;
}

/**
 * The TS half of the cross-implementation parity gate. Every vector in
 * `expression-vectors.json` (generated from THIS module) must still reproduce
 * here, and `AvatarExpressionVectorTests.swift` asserts the same file through
 * the Swift port — so the two renderers of one grammar cannot drift apart
 * silently. Regenerate with `gen-expression-vectors.mjs` after an intentional
 * change and fix whichever side moved.
 */
describe('agent-avatar expression vectors', () => {
  it('pins the constants both platforms share', () => {
    expect(vectors.constants).toEqual({
      eyeRadius: EYE_R,
      eyeCenterY: EYE_CY,
      leftEyeX: LEFT_CX,
      rightEyeX: RIGHT_CX,
      pupilRadius: PUPIL_R,
      maxOffset: MAX_OFFSET,
      socketMinRx: SOCKET_MIN_RX,
      pupilMinFraction: PUPIL_MIN_FRACTION,
      shapeEase: SHAPE_EASE,
      lidEase: LID_EASE,
      glowerLid: GLOWER_LID,
      glowerSeconds: GLOWER_MS / 1000,
      scrutinyLid: SCRUTINY_LID,
      scrutinySeconds: SCRUTINY_MS / 1000,
      drowseStartLid: DROWSE_START_LID,
      drowseEndLid: DROWSE_END_LID,
      drowseRampSeconds: DROWSE_RAMP_S,
      defaultDrowseDelaySeconds: DEFAULT_DROWSE_DELAY_S,
      popSeconds: POP_MS / 1000,
      popGain: POP_GAIN,
      blinkApexSeconds: BLINK_APEX_MS / 1000,
      blinkSquish: BLINK_SQUISH,
      browHalfWidth: BROW_HALF_WIDTH,
      browY: BROW_Y,
      browStroke: BROW_STROKE,
      recockFlipChance: RECOCK_FLIP_CHANCE,
      saccadeIntervalSeconds: SACCADE_INTERVAL_MS / 1000,
      saccadeEase: SACCADE_EASE,
      wanderIntervalSeconds: WANDER_INTERVAL_MS / 1000,
      wanderEase: WANDER_EASE,
      anchorEase: ANCHOR_EASE,
      lidOvershoot: LID_OVERSHOOT,
      lidLineEpsilon: LID_LINE_EPSILON,
    });
  });

  it('pins the gaze tables and the resting poses', () => {
    expect(vectors.saccadeTargets).toEqual(SACCADE_TARGETS);
    expect(vectors.wanderTargets).toEqual(WANDER_TARGETS);
    expect(vectors.restGaze).toEqual(REST_GAZE);
    expect(vectors.baseBrows).toEqual(BASE_BROWS);
  });

  it('reproduces every shape-channel vector', () => {
    for (const vector of vectors.socketRx) {
      expect(socketRx(vector.shape)).toBeCloseTo(vector.expected, 10);
    }
    for (const vector of vectors.pupilRx) {
      expect(pupilRx(vector.radius, vector.shape)).toBeCloseTo(vector.expected, 10);
    }
    for (const vector of vectors.shapeTarget) {
      expect(shapeTargetFor(vector.activity as never)).toBe(vector.expected);
    }
    expect(vectors.socketRx.length).toBeGreaterThanOrEqual(5);
  });

  it('reproduces every fill and travel vector', () => {
    for (const vector of vectors.fillToPupilScale) {
      expect(fillToPupilScale(vector.fill)).toBeCloseTo(vector.expected, 10);
    }
    for (const vector of vectors.travelClamp) {
      expect(travelClamp(vector.pupilRadius)).toBeCloseTo(vector.expected, 10);
    }
  });

  it('reproduces every lid and chord vector', () => {
    for (const vector of vectors.lidY) {
      expect(topLidY(vector.fraction)).toBeCloseTo(vector.top, 10);
      expect(bottomLidY(vector.fraction)).toBeCloseTo(vector.bottom, 10);
    }
    for (const vector of vectors.chordHalfWidth) {
      const y = vector.edge === 'top' ? topLidY(vector.fraction) : bottomLidY(vector.fraction);
      expect(chordHalfWidth(y, vector.shape)).toBeCloseTo(vector.expected, 10);
    }
    expect(vectors.chordHalfWidth.length).toBeGreaterThanOrEqual(30);
  });

  it('reproduces every drowse, pop and easing vector', () => {
    for (const vector of vectors.drowseLid) {
      expect(drowseLid(vector.awaitingSeconds, vector.delaySeconds)).toBeCloseTo(
        vector.expected,
        10
      );
    }
    for (const vector of vectors.popScale) {
      expect(popScale(vector.remainingSeconds * 1000)).toBeCloseTo(vector.expected, 10);
    }
    for (const vector of vectors.approach) {
      expect(approach(vector.current, vector.target, vector.rate, vector.dt)).toBeCloseTo(
        vector.expected,
        10
      );
    }
  });

  it('reproduces every brow re-cock and gaze-index vector', () => {
    for (const vector of vectors.recockBrows) {
      expect(recockBrows(vector.previous, sequence(vector.randoms))).toEqual(vector.expected);
    }
    for (const vector of vectors.nextGazeIndex) {
      expect(nextGazeIndex(vector.current, vector.count, () => vector.random)).toBe(
        vector.expected
      );
    }
  });

  it('reproduces every activity-parsing vector', () => {
    for (const vector of vectors.parseActivity) {
      expect(parseActivity(vector.raw)).toBe(vector.expected);
    }
  });
});
