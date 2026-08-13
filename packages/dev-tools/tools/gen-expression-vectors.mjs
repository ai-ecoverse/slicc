#!/usr/bin/env npx tsx
// Generate pinned agent-avatar expression vectors for cross-implementation
// parity: runs the canonical TS grammar
// (packages/webcomponents/src/switcher/avatar-expression.ts) over a fixed
// input table and writes the expected scalars to
//   packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/expression-vectors.json
// which is asserted by BOTH suites:
//   - packages/webcomponents/tests/switcher/expression-vectors.test.ts (TS must still produce it)
//   - AvatarExpressionVectorTests.swift                                (Swift must match it)
//
// The expression kit is a GRAMMAR shared by two renderers: a scalar that drifts
// on one platform silently un-mirrors the face on the other. Regenerate after
// an intentional grammar change and fix whichever side moved:
//   npx tsx packages/dev-tools/tools/gen-expression-vectors.mjs
//
// Time inputs are SECONDS on both sides; the TS module spells the same
// durations in milliseconds, so this file converts at the call.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expression = await import('../../webcomponents/src/switcher/avatar-expression.ts');

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(
  here,
  '../../ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/expression-vectors.json'
);

/** A deterministic stand-in for Math.random that walks a fixed sequence. */
function sequence(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

const constants = {
  eyeRadius: expression.EYE_R,
  eyeCenterY: expression.EYE_CY,
  leftEyeX: expression.LEFT_CX,
  rightEyeX: expression.RIGHT_CX,
  pupilRadius: expression.PUPIL_R,
  maxOffset: expression.MAX_OFFSET,
  socketMinRx: expression.SOCKET_MIN_RX,
  pupilMinFraction: expression.PUPIL_MIN_FRACTION,
  shapeEase: expression.SHAPE_EASE,
  lidEase: expression.LID_EASE,
  glowerLid: expression.GLOWER_LID,
  glowerSeconds: expression.GLOWER_MS / 1000,
  scrutinyLid: expression.SCRUTINY_LID,
  scrutinySeconds: expression.SCRUTINY_MS / 1000,
  drowseStartLid: expression.DROWSE_START_LID,
  drowseEndLid: expression.DROWSE_END_LID,
  drowseRampSeconds: expression.DROWSE_RAMP_S,
  defaultDrowseDelaySeconds: expression.DEFAULT_DROWSE_DELAY_S,
  popSeconds: expression.POP_MS / 1000,
  popGain: expression.POP_GAIN,
  blinkApexSeconds: expression.BLINK_APEX_MS / 1000,
  blinkSquish: expression.BLINK_SQUISH,
  browHalfWidth: expression.BROW_HALF_WIDTH,
  browY: expression.BROW_Y,
  browStroke: expression.BROW_STROKE,
  recockFlipChance: expression.RECOCK_FLIP_CHANCE,
  saccadeIntervalSeconds: expression.SACCADE_INTERVAL_MS / 1000,
  saccadeEase: expression.SACCADE_EASE,
  wanderIntervalSeconds: expression.WANDER_INTERVAL_MS / 1000,
  wanderEase: expression.WANDER_EASE,
  anchorEase: expression.ANCHOR_EASE,
  lidOvershoot: expression.LID_OVERSHOOT,
  lidLineEpsilon: expression.LID_LINE_EPSILON,
};

// The circle→rounded-square morph, at rest, mid-morph and full square.
const socketRx = [0, 0.25, 0.5, 0.75, 1].map((shape) => ({
  shape,
  expected: expression.socketRx(shape),
}));

const pupilRx = [
  { radius: 18, shape: 0 },
  { radius: 18, shape: 0.5 },
  { radius: 18, shape: 1 },
  { radius: 39.6, shape: 1 },
].map((v) => ({ ...v, expected: expression.pupilRx(v.radius, v.shape) }));

// The three-part context-fill ramp, including both knees.
const fillToPupilScale = [0, 50, 60, 67.5, 85, 100].map((fill) => ({
  fill,
  expected: expression.fillToPupilScale(fill),
}));

// Travel stays clamped to a CIRCLE even in a square socket, both bounds.
const travelClamp = [0, 18, 22, 30, 36, 40].map((pupilRadius) => ({
  pupilRadius,
  expected: expression.travelClamp(pupilRadius),
}));

// An open lid parks off the socket; an engaged one cuts across it.
const lidY = [0, 0.1, 0.22, 0.38, 0.5, 0.55, 1].map((fraction) => ({
  fraction,
  top: expression.topLidY(fraction),
  bottom: expression.bottomLidY(fraction),
}));

// The chord that closes the outline at a cut, tracking the socket radius.
const chordHalfWidth = [];
for (const fraction of [0.1, 0.22, 0.38, 0.5, 0.55]) {
  for (const shape of [0, 0.5, 1]) {
    for (const edge of ['top', 'bottom']) {
      const y = edge === 'top' ? expression.topLidY(fraction) : expression.bottomLidY(fraction);
      chordHalfWidth.push({
        fraction,
        shape,
        edge,
        expected: expression.chordHalfWidth(y, shape),
      });
    }
  }
}

// The soft arrival lid, the ramp, and its settled floor.
const drowseLid = [
  { awaitingSeconds: 0, delaySeconds: 90 },
  { awaitingSeconds: 89.9, delaySeconds: 90 },
  { awaitingSeconds: 90, delaySeconds: 90 },
  { awaitingSeconds: 96, delaySeconds: 90 },
  { awaitingSeconds: 102, delaySeconds: 90 },
  { awaitingSeconds: 900, delaySeconds: 90 },
  { awaitingSeconds: 6, delaySeconds: 0 },
].map((v) => ({ ...v, expected: expression.drowseLid(v.awaitingSeconds, v.delaySeconds) }));

// The wake pop decays over its transient window and never persists.
const popScale = [-1, 0, 0.175, 0.35, 1].map((remainingSeconds) => ({
  remainingSeconds,
  expected: expression.popScale(remainingSeconds * 1000),
}));

// The integrator every scalar channel runs on, including the long-frame clamp.
const approach = [
  { current: 0, target: 1, rate: 6, dt: 1 / 60 },
  { current: 0, target: 1, rate: 5, dt: 0.05 },
  { current: 0.38, target: 0, rate: 5, dt: 0.1 },
  { current: 0, target: 1, rate: 6, dt: 10 },
  { current: 0.5, target: 0.5, rate: 9, dt: 0.016 },
].map((v) => ({ ...v, expected: expression.approach(v.current, v.target, v.rate, v.dt) }));

const shapeTarget = ['idle', 'thinking', 'working', 'awaiting', null].map((activity) => ({
  activity,
  expected: expression.shapeTargetFor(activity),
}));

const parseActivity = ['idle', 'thinking', 'working', 'awaiting', 'nonsense', ''].map((raw) => ({
  raw,
  expected: expression.parseActivity(raw),
}));

// The re-cock, driven by a pinned random sequence so the jitter is exact:
// roll 1 decides the flip, then lift, arch, settled raise, settled tilt.
const recockBrows = [
  { name: 'flip-to-right', randoms: [0.1, 0.5, 0.5, 0.5, 0.5] },
  { name: 'hold-left', randoms: [0.9, 0.2, 0.8, 0.4, 0.6] },
  { name: 'flip-low-jitter', randoms: [0.0, 0.0, 0.0, 0.0, 0.0] },
  { name: 'hold-high-jitter', randoms: [0.99, 0.999, 0.999, 0.999, 0.999] },
].map((v) => ({
  ...v,
  previous: expression.BASE_BROWS,
  expected: expression.recockBrows(expression.BASE_BROWS, sequence(v.randoms)),
}));

const nextGazeIndex = [
  { current: 0, count: 5, random: 0 },
  { current: 0, count: 5, random: 0.5 },
  { current: 0, count: 5, random: 0.99 },
  { current: 4, count: 5, random: 0.5 },
  { current: 0, count: 1, random: 0.5 },
].map((v) => ({
  ...v,
  expected: expression.nextGazeIndex(v.current, v.count, () => v.random),
}));

const pinned = {
  $comment:
    'Cross-implementation parity vectors for the agent-avatar expression kit. ' +
    'Generated from the canonical TS grammar by gen-expression-vectors.mjs and ' +
    'asserted by BOTH the vitest suite and AvatarExpressionVectorTests.swift, so ' +
    'neither renderer can drift. Times are seconds. Do not hand-edit.',
  constants,
  saccadeTargets: expression.SACCADE_TARGETS,
  wanderTargets: expression.WANDER_TARGETS,
  restGaze: expression.REST_GAZE,
  baseBrows: expression.BASE_BROWS,
  socketRx,
  pupilRx,
  fillToPupilScale,
  travelClamp,
  lidY,
  chordHalfWidth,
  drowseLid,
  popScale,
  approach,
  shapeTarget,
  parseActivity,
  recockBrows,
  nextGazeIndex,
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(pinned, null, 2)}\n`);
const count = Object.values(pinned).filter(Array.isArray).flat().length;
console.log(`wrote ${count} expression vectors to ${out}`);
