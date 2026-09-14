export type AgentActivity = 'idle' | 'thinking' | 'working' | 'awaiting';

export const ACTIVITIES: readonly AgentActivity[] = ['idle', 'thinking', 'working', 'awaiting'];

export interface GazePoint {
  readonly x: number;
  readonly y: number;
}

export interface BrowPose {
  readonly raise: number;

  readonly tilt: number;
}

export interface BrowPair {
  readonly left: BrowPose;
  readonly right: BrowPose;
}

export const EYE_R = 38;
export const EYE_CY = 50;
export const LEFT_CX = 55;
export const RIGHT_CX = 145;
export const PUPIL_R = 18;
export const MAX_OFFSET = 16;

export const SOCKET_MIN_RX = 10;

export const PUPIL_MIN_FRACTION = 0.22;

export const SHAPE_EASE = 6;

export const BLINK_IN_MS = 110;
export const BLINK_OUT_MS = 130;

export const BLINK_APEX_MS = 120;
export const BLINK_SQUISH = 0.08;
export const BLINK_PERIOD_LEFT_MS = 3400;
export const BLINK_PERIOD_RIGHT_MS = 4600;

export const LID_EASE = 5;

export const GLOWER_LID = 0.38;
export const GLOWER_MS = 2600;

export const SCRUTINY_LID = 0.22;
export const SCRUTINY_MS = 1000;
export const DROWSE_START_LID = 0.1;
export const DROWSE_END_LID = 0.55;
export const DROWSE_RAMP_S = 12;
export const DEFAULT_DROWSE_DELAY_S = 90;

export const LID_OPEN_EPSILON = 0.001;

export const LID_LINE_EPSILON = 0.02;

export const LID_OVERSHOOT = 3;

export const POP_MS = 350;
export const POP_GAIN = 0.16;

export const BROW_HALF_WIDTH = 22;
export const BROW_Y = 2;
export const BROW_STROKE = 8;
export const BROW_TRANSITION_MS = 350;

export const RECOCK_FLIP_CHANCE = 0.65;

export const BASE_BROWS: BrowPair = {
  left: { raise: -9, tilt: -10 },
  right: { raise: 2, tilt: 6 },
};

export const SACCADE_TARGETS: readonly GazePoint[] = [
  { x: 45, y: -15 },
  { x: 150, y: -10 },
  { x: 95, y: -25 },
  { x: 160, y: -30 },
  { x: 40, y: -28 },
];
export const SACCADE_INTERVAL_MS = 1300;
export const SACCADE_EASE = 9;

export const WANDER_TARGETS: readonly GazePoint[] = [
  { x: 70, y: 60 },
  { x: 130, y: 40 },
  { x: 100, y: 72 },
  { x: 55, y: 30 },
  { x: 148, y: 62 },
];
export const WANDER_INTERVAL_MS = 4100;
export const WANDER_EASE = 2.2;
export const ANCHOR_EASE = 6;

export const REST_GAZE: GazePoint = { x: 100, y: 66 };

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, rate * dt);
}

export function parseActivity(value: string | null): AgentActivity | null {
  if (value === null) return null;
  return (ACTIVITIES as readonly string[]).includes(value) ? (value as AgentActivity) : 'idle';
}

export function parseDrowseDelay(value: string | null): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DROWSE_DELAY_S;
}

export function shapeTargetFor(activity: AgentActivity | null): number {
  return activity === 'working' ? 1 : 0;
}

export function socketRx(shape: number): number {
  return lerp(EYE_R, SOCKET_MIN_RX, shape);
}

export function pupilRx(radius: number, shape: number): number {
  return lerp(radius, radius * PUPIL_MIN_FRACTION, shape);
}

export function fillToPupilScale(fill: number): number {
  if (fill <= 50) return 1;
  if (fill >= 85) return 2.2;
  return 1 + ((fill - 50) / 35) * 1.2;
}

export function popScale(remainingMs: number): number {
  return remainingMs <= 0 ? 1 : 1 + POP_GAIN * Math.min(1, remainingMs / POP_MS);
}

export function travelClamp(pupilRadius: number): number {
  return Math.max(2, Math.min(MAX_OFFSET, EYE_R - pupilRadius - 4));
}

export function topLidY(fraction: number): number {
  return fraction > LID_OPEN_EPSILON
    ? EYE_CY - EYE_R + fraction * 2 * EYE_R
    : EYE_CY - EYE_R - LID_OVERSHOOT;
}

export function bottomLidY(fraction: number): number {
  return fraction > LID_OPEN_EPSILON
    ? EYE_CY + EYE_R - fraction * 2 * EYE_R
    : EYE_CY + EYE_R + LID_OVERSHOOT;
}

export function chordHalfWidth(y: number, shape: number): number {
  const dy = y - EYE_CY;
  const round = Math.sqrt(Math.max(0, EYE_R * EYE_R - dy * dy));
  return lerp(round, EYE_R - 2, shape);
}

export function drowseLid(awaitingSeconds: number, delaySeconds: number): number {
  if (awaitingSeconds <= delaySeconds) return DROWSE_START_LID;
  const t = Math.min(1, (awaitingSeconds - delaySeconds) / DROWSE_RAMP_S);
  return lerp(DROWSE_START_LID, DROWSE_END_LID, t);
}

export function isLeftRaised(pair: BrowPair): boolean {
  return pair.left.raise < 0;
}

export function recockBrows(previous: BrowPair, random: () => number = Math.random): BrowPair {
  const leftRaised =
    random() < RECOCK_FLIP_CHANCE ? !isLeftRaised(previous) : isLeftRaised(previous);
  const raised: BrowPose = { raise: -(7 + random() * 5), tilt: 7 + random() * 5 };
  const settled: BrowPose = { raise: 1 + random() * 2, tilt: 4 + random() * 3 };

  return leftRaised
    ? { left: { raise: raised.raise, tilt: -raised.tilt }, right: settled }
    : { left: { raise: settled.raise, tilt: -settled.tilt }, right: raised };
}

export function nextGazeIndex(current: number, length: number, random: () => number): number {
  if (length < 2) return 0;
  return (current + 1 + Math.floor(random() * (length - 1))) % length;
}
