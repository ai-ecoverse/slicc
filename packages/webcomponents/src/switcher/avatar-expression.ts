/**
 * The DOM-free grammar behind `<slicc-agent-avatar>`'s expression kit.
 *
 * Every channel here is a **point** (gaze), a **scalar** (socket corner radius,
 * lid fractions, brow raise/tilt) or an **event** (blink, pupil pop, glower,
 * scrutiny) — never a bespoke drawing. That is deliberate: the same scalars map
 * 1:1 onto SwiftUI (`RoundedRectangle(cornerRadius:)`, a `Rectangle` mask
 * offset, `Capsule` + `rotationEffect`), so the iOS `SliccAgentAvatarView`
 * mirror can reuse this arithmetic verbatim.
 *
 * Reference table (channels, precedence, constants):
 * `docs/webcomponents-details.md#agent-avatar-expression-kit`.
 */

/** What the agent is doing — the shape channel's only input. */
export type AgentActivity = 'idle' | 'thinking' | 'working' | 'awaiting';

export const ACTIVITIES: readonly AgentActivity[] = ['idle', 'thinking', 'working', 'awaiting'];

/** A gaze aim point in the 200×100 eye-band viewBox. */
export interface GazePoint {
  readonly x: number;
  readonly y: number;
}

/** One brow capsule: how far it lifts, and how far it tips. */
export interface BrowPose {
  /** Vertical offset in viewBox units; negative lifts the brow away from the eye. */
  readonly raise: number;
  /** Rotation in degrees. On the left brow a negative tilt raises the INNER end. */
  readonly tilt: number;
}

export interface BrowPair {
  readonly left: BrowPose;
  readonly right: BrowPose;
}

// ── Band geometry (shared with the component and the iOS mirror) ────────────
export const EYE_R = 38;
export const EYE_CY = 50;
export const LEFT_CX = 55;
export const RIGHT_CX = 145;
export const PUPIL_R = 18;
export const MAX_OFFSET = 16;

// ── Shape channel ──────────────────────────────────────────────────────────
/** Socket corner radius at full square. A rect with `rx = r` IS a circle. */
export const SOCKET_MIN_RX = 10;
/** Pupil corner radius at full square, as a fraction of the pupil radius. */
export const PUPIL_MIN_FRACTION = 0.22;
/** Shape integrator rate (per second). Blink-gated commits snap past it. */
export const SHAPE_EASE = 6;

// ── Blink channel ──────────────────────────────────────────────────────────
export const BLINK_IN_MS = 110;
export const BLINK_OUT_MS = 130;
/** The apex: lid fully down, the one moment a shape change may be committed. */
export const BLINK_APEX_MS = 120;
export const BLINK_SQUISH = 0.08;
export const BLINK_PERIOD_LEFT_MS = 3400;
export const BLINK_PERIOD_RIGHT_MS = 4600;

// ── Lid channel ────────────────────────────────────────────────────────────
export const LID_EASE = 5;
/** Top lid on a failed tool call — reads angry, which is the point. */
export const GLOWER_LID = 0.38;
export const GLOWER_MS = 2600;
/** Bottom lid while the user types — focused attention on what is being said. */
export const SCRUTINY_LID = 0.22;
export const SCRUTINY_MS = 1000;
export const DROWSE_START_LID = 0.1;
export const DROWSE_END_LID = 0.55;
export const DROWSE_RAMP_S = 12;
export const DEFAULT_DROWSE_DELAY_S = 90;
/** Below this the lid is treated as open and parked off the eye entirely. */
export const LID_OPEN_EPSILON = 0.001;
/** Below this the chord line stays hidden (a 0-width line still paints a cap). */
export const LID_LINE_EPSILON = 0.02;
/** How far past the socket an open lid clip is parked, so the stroke survives. */
export const LID_OVERSHOOT = 3;

// ── Pupil pop (a transient, so the fill channel stays honest) ───────────────
export const POP_MS = 350;
export const POP_GAIN = 0.16;

// ── Brow channel ───────────────────────────────────────────────────────────
export const BROW_HALF_WIDTH = 22;
export const BROW_Y = 2;
export const BROW_STROKE = 8;
export const BROW_TRANSITION_MS = 350;
/** Chance that a re-cock flips which brow is the raised one. */
export const RECOCK_FLIP_CHANCE = 0.65;
/** The pose thinking opens with: left raised and quizzical, right settled. */
export const BASE_BROWS: BrowPair = {
  left: { raise: -9, tilt: -10 },
  right: { raise: 2, tilt: 6 },
};

// ── Gaze channel ───────────────────────────────────────────────────────────
/** Up-and-away, the way a thinking creature looks off past your shoulder. */
export const SACCADE_TARGETS: readonly GazePoint[] = [
  { x: 45, y: -15 },
  { x: 150, y: -10 },
  { x: 95, y: -25 },
  { x: 160, y: -30 },
  { x: 40, y: -28 },
];
export const SACCADE_INTERVAL_MS = 1300;
export const SACCADE_EASE = 9;
/** Lower/mid region: alive, demanding nothing. */
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
/** Where `awaiting` looks when no `gaze-target` resolves: slightly down-centre. */
export const REST_GAZE: GazePoint = { x: 100, y: 66 };

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** One frame of exponential easing — the integrator every scalar channel uses. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, rate * dt);
}

/**
 * An absent attribute means "no expression engine" (legacy pointer-tracking
 * behaviour), which is why this returns `null` rather than defaulting. A present
 * but unrecognised value reads as `idle` — the quietest treatment.
 */
export function parseActivity(value: string | null): AgentActivity | null {
  if (value === null) return null;
  return (ACTIVITIES as readonly string[]).includes(value) ? (value as AgentActivity) : 'idle';
}

export function parseDrowseDelay(value: string | null): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DROWSE_DELAY_S;
}

/** Only tool work squares the eyes up; everything else is the resting circle. */
export function shapeTargetFor(activity: AgentActivity | null): number {
  return activity === 'working' ? 1 : 0;
}

export function socketRx(shape: number): number {
  return lerp(EYE_R, SOCKET_MIN_RX, shape);
}

export function pupilRx(radius: number, shape: number): number {
  return lerp(radius, radius * PUPIL_MIN_FRACTION, shape);
}

/** Pupil radius for a fill percentage — the existing context-fill channel. */
export function fillToPupilScale(fill: number): number {
  if (fill <= 50) return 1;
  if (fill >= 85) return 2.2;
  return 1 + ((fill - 50) / 35) * 1.2;
}

export function popScale(remainingMs: number): number {
  return remainingMs <= 0 ? 1 : 1 + POP_GAIN * Math.min(1, remainingMs / POP_MS);
}

/** Pupil travel stays clamped to a CIRCLE even in a square socket, for parity. */
export function travelClamp(pupilRadius: number): number {
  return Math.max(2, Math.min(MAX_OFFSET, EYE_R - pupilRadius - 4));
}

/** Y of the top-lid cut; an open lid parks the cut just off the socket. */
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

/**
 * Half-width of the chord line that closes the outline at a lid cut. It tracks
 * the socket's current corner radius: circular sockets get the true chord,
 * squared ones widen to the flat edge.
 */
export function chordHalfWidth(y: number, shape: number): number {
  const dy = y - EYE_CY;
  const round = Math.sqrt(Math.max(0, EYE_R * EYE_R - dy * dy));
  return lerp(round, EYE_R - 2, shape);
}

/**
 * The awaiting lid: a soft 10% on arrival, then a slow descent to 55% once the
 * agent has been kept waiting past `delaySeconds`.
 */
export function drowseLid(awaitingSeconds: number, delaySeconds: number): number {
  if (awaitingSeconds <= delaySeconds) return DROWSE_START_LID;
  const t = Math.min(1, (awaitingSeconds - delaySeconds) / DROWSE_RAMP_S);
  return lerp(DROWSE_START_LID, DROWSE_END_LID, t);
}

export function isLeftRaised(pair: BrowPair): boolean {
  return pair.left.raise < 0;
}

/**
 * The re-cock, committed at a blink apex: the raised side flips more often than
 * not, and the constants re-jitter either way, so thinking gets a beat —
 * hmm… (blink) …hmm?
 */
export function recockBrows(previous: BrowPair, random: () => number = Math.random): BrowPair {
  const leftRaised =
    random() < RECOCK_FLIP_CHANCE ? !isLeftRaised(previous) : isLeftRaised(previous);
  const raised: BrowPose = { raise: -(7 + random() * 5), tilt: 7 + random() * 5 };
  const settled: BrowPose = { raise: 1 + random() * 2, tilt: 4 + random() * 3 };
  // The left brow mirrors: a negative tilt raises its inner (right-hand) end.
  return leftRaised
    ? { left: { raise: raised.raise, tilt: -raised.tilt }, right: settled }
    : { left: { raise: settled.raise, tilt: -settled.tilt }, right: raised };
}

/** Next auto-gaze index — never the current one, so every hop is visible. */
export function nextGazeIndex(current: number, length: number, random: () => number): number {
  if (length < 2) return 0;
  return (current + 1 + Math.floor(random() * (length - 1))) % length;
}
