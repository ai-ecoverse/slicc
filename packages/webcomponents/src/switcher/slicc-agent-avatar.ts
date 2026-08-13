import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import {
  type AgentActivity,
  ANCHOR_EASE,
  approach,
  BASE_BROWS,
  BLINK_APEX_MS,
  BLINK_IN_MS,
  BLINK_OUT_MS,
  BLINK_PERIOD_LEFT_MS,
  BLINK_PERIOD_RIGHT_MS,
  BLINK_SQUISH,
  BROW_HALF_WIDTH,
  BROW_STROKE,
  BROW_TRANSITION_MS,
  BROW_Y,
  type BrowPair,
  bottomLidY,
  chordHalfWidth,
  DROWSE_RAMP_S,
  drowseLid,
  EYE_CY,
  EYE_R,
  fillToPupilScale,
  type GazePoint,
  GLOWER_LID,
  GLOWER_MS,
  LEFT_CX,
  LID_EASE,
  LID_LINE_EPSILON,
  LID_OVERSHOOT,
  MAX_OFFSET,
  nextGazeIndex,
  POP_MS,
  PUPIL_R,
  parseActivity,
  parseDrowseDelay,
  popScale,
  pupilRx,
  REST_GAZE,
  RIGHT_CX,
  recockBrows,
  SACCADE_EASE,
  SACCADE_INTERVAL_MS,
  SACCADE_TARGETS,
  SCRUTINY_LID,
  SCRUTINY_MS,
  SHAPE_EASE,
  shapeTargetFor,
  socketRx,
  topLidY,
  travelClamp,
  WANDER_EASE,
  WANDER_INTERVAL_MS,
  WANDER_TARGETS,
} from './avatar-expression.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LEFT_EYE = { cx: LEFT_CX, cy: EYE_CY, r: EYE_R } as const;
const RIGHT_EYE = { cx: RIGHT_CX, cy: EYE_CY, r: EYE_R } as const;
const NOISE_CELL_SIZE = 1;
const NOISE_FPS = 12;
const NOISE_OPACITY = 0.72;
const NOISE_LUMINANCE = [0.08, 0.36, 0.68, 0.94] as const;
const FROZEN_NOISE_SEED = 0x51cc_a11e;
const NOISE_FRAME_SALT = 0x9e37_79b9;
const NOISE_EYE_SALT = 0x85eb_ca6b;
const IOS_REFERENCE_DATE_MS = Date.UTC(2001, 0, 1);
/** Layout of the `gaze-target` element is re-read at most this often, never per frame. */
const ANCHOR_REFRESH_MS = 500;

interface TypeConfig {
  vb: string;
  eyes: { top: number; left: number; width: number; height: number };
  zoom: number;
  glyph: number;
}

const TYPE: Record<'cone' | 'scoop', TypeConfig> = {
  cone: {
    vb: '70 330 440 570',
    eyes: { top: -18.5, left: 17, width: 70, height: 44 },
    zoom: 3,
    glyph: 96,
  },
  scoop: {
    vb: '0 0 580 470',
    eyes: { top: 30, left: 15, width: 70, height: 45 },
    zoom: 2.65,
    glyph: 96,
  },
};

const DEFAULT_COLOR = { cone: '#D2691E', scoop: '#FFB6C1' } as const;

const STYLE = `
:host{display:block;width:26px;height:26px;pointer-events:none;}
.avatar{position:relative;display:block;width:100%;height:100%;overflow:hidden;border-radius:7px;background:color-mix(in srgb,var(--slicc-agent-tabs-hue) 18%,transparent);}
.icon-inner{position:absolute;inset:0;transform-origin:0 0;transform:translate(var(--tx),var(--ty)) scale(var(--zoom));}
.glyph{position:absolute;left:50%;top:50%;display:block;width:var(--g);height:var(--g);overflow:visible;transform:translate(-50%,-50%);}
.eyes{position:absolute;pointer-events:none;}
.eyes-svg{display:block;overflow:visible;}
.eye-blink,.eye-frozen{transform-box:view-box;}
@keyframes slicc-agent-avatar-blink{0%,92%,100%{transform:scaleY(1);}96%{transform:scaleY(${BLINK_SQUISH});}}
:host([blink]) .eye-blink{animation:slicc-agent-avatar-blink 3.4s ease-in-out infinite;}
:host([blink]) .eye-r{animation-duration:4.6s;}
/* The engine drives blinks itself so it can commit shape changes at the apex. */
.avatar[data-expressive] .eye-blink{animation:none;}
.brow{transition:opacity ${BROW_TRANSITION_MS}ms ease,transform ${BROW_TRANSITION_MS}ms ease;}
@media (prefers-reduced-motion:reduce){:host([blink]) .eye-blink{animation:none;}.brow{transition:none;}}
`;

const SHEET = sheet(STYLE);

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  ...children: SVGElement[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  element.append(...children);
  return element;
}

/** Set an attribute only when it actually changes — attribute reads force no layout. */
function setAttr(element: Element | null, name: string, value: string): void {
  if (!element) return;
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setNumber(element: Element | null, name: string, value: number): void {
  setAttr(element, name, value.toFixed(2));
}

function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? [...value].map((part) => `${part}${part}`).join('') : value;
  const parsed = Number.parseInt(full, 16);
  if (!Number.isFinite(parsed)) return hex;
  const target = amount < 0 ? 0 : 255;
  const mix = (channel: number): string =>
    Math.round(channel + (target - channel) * Math.abs(amount))
      .toString(16)
      .padStart(2, '0');
  return `#${mix((parsed >> 16) & 255)}${mix((parsed >> 8) & 255)}${mix(parsed & 255)}`;
}

function coneInner(base: string, outline: string, waffle: string): SVGElement[] {
  const shapes: Array<[keyof SVGElementTagNameMap, Record<string, string | number>]> = [
    [
      'path',
      {
        d: 'M108.22,414.88l189.84,460.03c1.36,3.3,6.09,3.16,7.25-.22l159.34-463.34c.87-2.53-1.03-5.16-3.7-5.13l-349.18,3.32c-2.74.03-4.59,2.82-3.55,5.35Z',
        fill: base,
        stroke: outline,
        'stroke-linejoin': 'round',
        'stroke-width': 20,
      },
    ],
    [
      'path',
      {
        d: 'M261.93,482.48h0c15.03-15.03,4.46-40.72-16.79-40.83h0c-21.37-.11-32.14,25.72-17.03,40.83h0c9.34,9.34,24.48,9.34,33.82,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M384.85,527.49l-51.82,51.82c-2.24,2.24-2.24,5.86,0,8.1l55.71,55.71c2.24,2.24,5.86,2.24,8.1,0h0c.62-.62,1.08-1.36,1.37-2.19l26.52-77.11c.71-2.07.18-4.36-1.37-5.91l-30.41-30.41c-2.24-2.24-5.86-2.24-8.1,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M371.7,684.58l-25.94,25.94c-2.24,2.24-2.24,5.86,0,8.1l12.67,12.67c2.99,2.99,8.09,1.82,9.46-2.19l13.28-38.61c1.97-5.74-5.17-10.2-9.46-5.91Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M159.42,564.14l2.73,6.83c1.52,3.82,6.46,4.83,9.37,1.93l2.05-2.05c2.24-2.24,2.24-5.86,0-8.1l-4.78-4.78c-4.4-4.4-11.67.39-9.37,6.17Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M243.92,633.11l-48.65-48.65c-5.24-5.24-13.74-5.24-18.99,0h0c-3.8,3.8-4.97,9.49-2.98,14.47l27.77,69.54c3.58,8.95,15.14,11.33,21.96,4.51l20.89-20.89c5.24-5.24,5.24-13.74,0-18.99Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M211.32,533.1h0c14.11-14.11,14.11-36.98,0-51.08l-34.94-34.94c-.72-.72-.72-1.89,0-2.62h0c1.16-1.16.34-3.15-1.3-3.16l-11.23-.06c-25.62-.13-43.23,25.72-33.73,49.51l5.37,13.45c1.82,4.55,4.54,8.68,8,12.15l16.74,16.74c14.11,14.11,36.98,14.11,51.08,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M263.74,792.53h0c-5.69,5.69-7.45,14.23-4.46,21.71l22.5,56.36c6.92,17.34,31.68,16.74,37.75-.92l8.66-25.2c2.5-7.28.64-15.35-4.8-20.79l-31.17-31.17c-7.87-7.87-20.62-7.87-28.48,0Z',
        fill: waffle,
      },
    ],
    [
      'path',
      {
        d: 'M392.94,503.07l40.81-40.81c2.24-2.24,5.86-2.24,8.1,0l.06.06c2.24,2.24,2.24,5.86,0,8.1l-40.81,40.81c-2.24,2.24-2.24,5.86,0,8.1l22.48,22.48c2.99,2.99,8.09,1.82,9.46-2.19l30.71-89.32c1.27-3.71-1.47-7.57-5.39-7.59l-120.63-.6c-5.11-.03-7.69,6.16-4.08,9.77l51.18,51.18c2.24,2.24,5.86,2.24,8.1,0Z',
        fill: waffle,
      },
    ],
  ];
  const rects = [
    [274.59, 463.59, 84.73, 95.66, 42.36, 'translate(-268.79 373.91) rotate(-45)'],
    [291.06, 603.84, 72.24, 90.24, 36.12, 'translate(-363.06 421.43) rotate(-45)'],
    [217.18, 527.25, 72.24, 95.66, 36.12, 'translate(-332.45 347.55) rotate(-45)'],
    [236.26, 661.25, 67.04, 90.24, 33.52, 'translate(-420.46 397.65) rotate(-45)'],
  ] as const;
  const result = shapes.map(([tag, attrs]) => svgEl(tag, attrs));
  result.push(
    ...rects.map(([x, y, width, height, radius, transform]) =>
      svgEl('rect', {
        x,
        y,
        width,
        height,
        rx: radius,
        ry: radius,
        transform,
        fill: waffle,
      })
    ),
    svgEl('ellipse', {
      cx: 288.37,
      cy: 404.38,
      rx: 182.34,
      ry: 67.01,
      fill: base,
      stroke: outline,
      'stroke-miterlimit': 10,
      'stroke-width': 20,
    })
  );
  return result;
}

function scoopInner(fill: string, outline: string): SVGElement[] {
  return [
    svgEl('path', {
      d: 'M566.75,340.67c0-29.85-12.97-56.87-33.96-76.47,4.8-9.98,7.44-20.71,7.44-31.9,0-38.29-30.62-71.33-74.92-86.77.33-3.07.51-6.17.51-9.3,0-69.72-84.29-126.24-188.26-126.24s-188.26,56.52-188.26,126.24c0,4,.29,7.95.83,11.86-34.94,15.4-58.48,44.25-58.48,77.34,0,18.21,7.15,34.25,19.39,49.26-25.1,19.88-41.05,49.47-41.05,82.54,0,59.85,52.15,108.37,116.49,108.37,10.83,0,21.3-1.4,31.26-3.98,31.42,41.91,83.55,69.34,142.55,69.34,64.73,0,121.2-33,151.11-81.94,63.8-.57,115.34-48.85,115.34-108.34Z',
      fill,
      stroke: outline,
      'stroke-width': 20,
    }),
  ];
}

/** A socket/pupil is always a rect: `rx = half the side` IS a circle, so the
 * whole shape channel is one animated attribute on both platforms. */
function squircle(
  cx: number,
  radius: number,
  rx: number,
  attrs: Record<string, string | number>
): SVGRectElement {
  return svgEl('rect', {
    x: cx - radius,
    y: EYE_CY - radius,
    width: radius * 2,
    height: radius * 2,
    rx,
    ...attrs,
  });
}

function pupil(cx: number, side: 'l' | 'r', pupilRadius: number, shape: number): SVGGElement {
  return svgEl(
    'g',
    { class: `pupil pupil-${side}` },
    squircle(cx, pupilRadius, pupilRx(pupilRadius, shape), { fill: '#000' }),
    svgEl('circle', {
      cx: cx - pupilRadius * 0.3,
      cy: EYE_CY - pupilRadius * 0.35,
      r: pupilRadius * 0.4,
      fill: '#fff',
    })
  );
}

function lidLine(cx: number, edge: 'top' | 'bottom'): SVGLineElement {
  return svgEl('line', {
    class: `lid-line lid-${edge}`,
    x1: cx - EYE_R,
    y1: EYE_CY,
    x2: cx + EYE_R,
    y2: EYE_CY,
    stroke: '#000',
    'stroke-width': 4,
    'stroke-linecap': 'round',
    display: 'none',
  });
}

function brow(cx: number, side: 'l' | 'r'): SVGLineElement {
  const line = svgEl('line', {
    class: `brow brow-${side}`,
    x1: cx - BROW_HALF_WIDTH,
    y1: BROW_Y,
    x2: cx + BROW_HALF_WIDTH,
    y2: BROW_Y,
    stroke: '#000',
    'stroke-width': BROW_STROKE,
    'stroke-linecap': 'round',
    opacity: 0,
  });
  line.style.transformBox = 'fill-box';
  line.style.transformOrigin = 'center';
  return line;
}

function eyeGroup(cx: number, side: 'l' | 'r', className: string): SVGGElement {
  const group = svgEl('g', { class: `${className} eye-${side}` });
  group.style.transformOrigin = `${cx}px ${EYE_CY}px`;
  return group;
}

function eyeStatic(cx: number, side: 'l' | 'r', rx: number): SVGGElement {
  const clipId = `slicc-agent-avatar-noise-${side}`;
  return svgEl(
    'g',
    { class: `eye-static eye-body-${side}` },
    svgEl(
      'defs',
      {},
      svgEl('clipPath', { id: clipId }, squircle(cx, EYE_R, rx, { class: 'noise-clip' }))
    ),
    squircle(cx, EYE_R, rx, { class: 'socket', fill: '#fff' }),
    svgEl('g', {
      class: `noise noise-${side}`,
      'clip-path': `url(#${clipId})`,
      'data-cell-size': NOISE_CELL_SIZE,
    }),
    squircle(cx, EYE_R, rx, {
      class: 'eye-outline',
      fill: 'none',
      stroke: '#000',
      'stroke-width': 4,
    })
  );
}

function xorshift32(state: number): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
}

function frozenNoiseSeed(eyeIndex: number): number {
  return (FROZEN_NOISE_SEED ^ Math.imul(eyeIndex, NOISE_EYE_SALT)) >>> 0;
}

function animatedNoiseSeed(eyeIndex: number, frame: number): number {
  return (frozenNoiseSeed(eyeIndex) ^ Math.imul(frame, NOISE_FRAME_SALT)) >>> 0;
}

function currentNoiseFrame(): number {
  return Math.floor(((Date.now() - IOS_REFERENCE_DATE_MS) / 1000) * NOISE_FPS) >>> 0;
}

function eyeDead(cx: number): SVGElement[] {
  return [
    svgEl('circle', { cx, cy: EYE_CY, r: EYE_R, fill: '#fff', stroke: '#000', 'stroke-width': 4 }),
    svgEl('line', {
      x1: cx - 15,
      y1: 35,
      x2: cx + 15,
      y2: 65,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
    svgEl('line', {
      x1: cx + 15,
      y1: 35,
      x2: cx - 15,
      y2: 65,
      stroke: '#000',
      'stroke-width': 8,
      'stroke-linecap': 'round',
    }),
  ];
}

function place(pupil: Element, cx: number, mx: number, my: number, maxOffset: number): void {
  const dx = mx - cx;
  const dy = my - EYE_CY;
  const distance = Math.hypot(dx, dy);
  const clamped = Math.min(distance, maxOffset);
  const tx = distance > 0 ? (dx / distance) * clamped : 0;
  const ty = distance > 0 ? (dy / distance) * clamped : 0;
  pupil.setAttribute('transform', `translate(${tx.toFixed(2)},${ty.toFixed(2)})`);
}

/** A read-only snapshot of every expression scalar — the shape a SwiftUI mirror binds to. */
export interface AvatarExpressionState {
  readonly activity: AgentActivity | null;
  /** 0 = circle, 1 = rounded square. */
  readonly shape: number;
  readonly lidTop: number;
  readonly lidBottom: number;
  readonly pupilRadius: number;
  readonly gaze: GazePoint;
  readonly brows: BrowPair;
  readonly browsVisible: boolean;
}

/**
 * The agent's face: gaze, context fill (pupil size), liveness (blink),
 * connection (TV static) and — via the `activity` attribute — the full
 * expression kit: shape morph, brows, lids and gaze behaviours.
 *
 * Without an `activity` attribute the element behaves exactly as it always has
 * (pointer-tracked pupils, CSS blink). Channels, precedence and constants:
 * `docs/webcomponents-details.md#agent-avatar-expression-kit`.
 */
export class SliccAgentAvatar extends HTMLElement {
  static readonly observedAttributes = [
    'type',
    'color',
    'eyes',
    'fill',
    'connection',
    'activity',
    'gaze-target',
    'drowse-delay',
  ];

  readonly #root: ShadowRoot;
  readonly #onPointerMove = (event: PointerEvent): void => this.#track(event);
  readonly #onMotionChange = (): void => {
    this.#syncTracking();
    this.#syncEngine();
    if (this.#eyeState() === 'static') this.#startNoise();
  };
  #motionQuery: MediaQueryList | null = null;
  #pupilL: Element | null = null;
  #pupilR: Element | null = null;
  #eyesSvg: SVGSVGElement | null = null;
  #noiseCells: SVGRectElement[][] = [];
  #noiseInterval: number | null = null;
  #maxOffset = MAX_OFFSET;
  #tracking = false;

  // ── expression engine ────────────────────────────────────────────────────
  #activity: AgentActivity | null = null;
  /** True once an expression method forced the engine on without an attribute. */
  #forced = false;
  #primed = false;
  #shape = 0;
  #shapeCommitted = 0;
  #committing = false;
  #lidTop = 0;
  #lidBottom = 0;
  #brows: BrowPair = BASE_BROWS;
  #gaze: GazePoint = { x: 100, y: EYE_CY };
  #gazeIndex = 0;
  #gazeChangedAt = 0;
  #pupilRadius = PUPIL_R;
  #awaitingSince = 0;
  #glowerUntil = 0;
  #scrutinyUntil = 0;
  #popUntil = 0;
  #frame: number | null = null;
  #lastStep = 0;
  #blinkTimers: number[] = [];
  #settleTimer: number | null = null;
  #blinkIntervals: number[] = [];
  #anchor: GazePoint = REST_GAZE;
  #anchorAt = 0;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.#motionQuery.addEventListener('change', this.#onMotionChange);
    this.#render();
    this.#syncTracking();
    this.#syncEngine();
  }

  disconnectedCallback(): void {
    this.#stopTracking();
    this.#stopNoise();
    this.#stopEngine();
    this.#motionQuery?.removeEventListener('change', this.#onMotionChange);
    this.#motionQuery = null;
    this.#primed = false;
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === 'activity' || name === 'gaze-target' || name === 'drowse-delay') {
      this.#syncActivity();
      return;
    }
    this.#render();
    this.#syncTracking();
    this.#syncEngine();
  }

  /** `idle | thinking | working | awaiting`, or `null` for the legacy behaviour. */
  get activity(): AgentActivity | null {
    return parseActivity(this.getAttribute('activity'));
  }

  set activity(value: AgentActivity | null) {
    if (value === null) this.removeAttribute('activity');
    else this.setAttribute('activity', value);
  }

  /** CSS selector (resolved in the owner document) the `awaiting` gaze anchors to. */
  get gazeTarget(): string | null {
    return this.getAttribute('gaze-target');
  }

  set gazeTarget(value: string | null) {
    if (value === null) this.removeAttribute('gaze-target');
    else this.setAttribute('gaze-target', value);
  }

  /** Seconds of `awaiting` before the drowse lid starts descending. */
  get drowseDelay(): number {
    return parseDrowseDelay(this.getAttribute('drowse-delay'));
  }

  set drowseDelay(value: number) {
    this.setAttribute('drowse-delay', String(value));
  }

  /** Read-only snapshot of every expression scalar. */
  get expression(): AvatarExpressionState {
    return Object.freeze({
      activity: this.#activity,
      shape: this.#shape,
      lidTop: this.#lidTop,
      lidBottom: this.#lidBottom,
      pupilRadius: this.#pupilRadius,
      gaze: { ...this.#gaze },
      brows: this.#brows,
      browsVisible: this.#browsVisible(),
    });
  }

  /**
   * "I saw that" — lifts the drowse lid, restarts the drowse clock, blinks once
   * and fires a 350 ms pupil pop. The pop is a transient so the fill channel
   * (pupil size = context fill) stays honest.
   */
  wake(): void {
    const now = performance.now();
    this.#awaitingSince = now;
    if (!this.#instant()) {
      this.#popUntil = now + POP_MS;
      this.#blinkBoth();
    }
    this.#refresh();
  }

  /** Focused attention on what is being typed — one second of raised bottom lid. */
  scrutinize(): void {
    this.#scrutinyUntil = performance.now() + SCRUTINY_MS;
    this.#refresh();
  }

  /** The 2.6 s reaction to a failed tool call. Reads angry; that is intended. */
  glower(): void {
    this.#glowerUntil = performance.now() + GLOWER_MS;
    this.#refresh();
  }

  #expressive(): boolean {
    return this.hasAttribute('activity') || this.#forced;
  }

  #render(): void {
    this.#stopNoise();
    this.#noiseCells = [];
    const type = this.getAttribute('type') === 'cone' ? 'cone' : 'scoop';
    const config = TYPE[type];
    const color = this.getAttribute('color') ?? DEFAULT_COLOR[type];
    const expressive = this.#expressive();
    this.#activity = parseActivity(this.getAttribute('activity'));
    // An avatar that MOUNTS in `awaiting` starts its waiting clock here; a later
    // transition into `awaiting` starts it in #syncActivity.
    if (this.#activity === 'awaiting' && this.#awaitingSince === 0) {
      this.#awaitingSince = performance.now();
    }
    if (!this.#primed) {
      this.#shape = this.#shapeCommitted = shapeTargetFor(this.#activity);
      this.#primed = true;
    }
    const glyph = svgEl(
      'svg',
      {
        class: 'glyph',
        viewBox: config.vb,
        preserveAspectRatio: 'xMidYMid meet',
        style: `--g:${config.glyph}%`,
      },
      ...(type === 'cone'
        ? coneInner(color, shade(color, -0.38), shade(color, 0.3))
        : scoopInner(color, shade(color, -0.32)))
    );
    this.#eyesSvg = svgEl(
      'svg',
      {
        class: 'eyes-svg',
        viewBox: '0 0 200 100',
        width: '100%',
        height: '100%',
        preserveAspectRatio: 'xMidYMid meet',
      },
      ...this.#buildEyes(expressive)
    );
    const eyeBand = h('span', {
      class: 'eyes',
      style: `top:${config.eyes.top}%;left:${config.eyes.left}%;width:${config.eyes.width}%;height:${config.eyes.height}%`,
    });
    eyeBand.append(this.#eyesSvg);
    const inner = h(
      'span',
      {
        class: 'icon-inner',
        style: `--tx:${((0.5 - config.zoom * ((config.eyes.left + config.eyes.width / 2) / 100)) * 100).toFixed(2)}%;--ty:${((0.5 - config.zoom * ((config.eyes.top + config.eyes.height / 2) / 100)) * 100).toFixed(2)}%;--zoom:${config.zoom}`,
      },
      glyph,
      eyeBand
    );
    this.#root.replaceChildren(
      h(
        'span',
        { class: 'avatar', 'aria-hidden': 'true', 'data-expressive': expressive || null },
        inner
      )
    );
    this.#pupilL = this.#root.querySelector('.pupil-l');
    this.#pupilR = this.#root.querySelector('.pupil-r');
    if (this.#eyeState() === 'static') this.#startNoise();
    if (expressive) this.#apply();
  }

  #buildEyes(expressive: boolean): SVGElement[] {
    const eyes = this.#eyeState();
    if (eyes === 'none') return [];
    if (eyes === 'dead') return [...eyeDead(LEFT_EYE.cx), ...eyeDead(RIGHT_EYE.cx)];
    this.#pupilRadius = this.#restingPupilRadius();
    this.#maxOffset = travelClamp(this.#pupilRadius);
    const rx = socketRx(this.#shape);
    return [LEFT_EYE.cx, RIGHT_EYE.cx].map((cx, index) => {
      const side = index === 0 ? 'l' : 'r';
      const frozen = eyes === 'static';
      const group = eyeGroup(cx, side, frozen ? 'eye-frozen' : 'eye-blink');
      const body = frozen
        ? eyeStatic(cx, side, rx)
        : svgEl(
            'g',
            { class: `eye-body eye-body-${side}` },
            squircle(cx, EYE_R, rx, {
              class: 'socket',
              fill: '#fff',
              stroke: '#000',
              'stroke-width': 4,
            }),
            pupil(cx, side, this.#pupilRadius, this.#shape)
          );
      group.append(body);
      if (!expressive) return group;
      // Lids clip the eye body only: the chord lines that close the outline at
      // the cut, and the brows, must stay outside the clip.
      const clipId = `slicc-agent-avatar-lid-${side}`;
      group.append(
        svgEl(
          'defs',
          {},
          svgEl(
            'clipPath',
            { id: clipId },
            svgEl('rect', {
              class: 'lid-clip',
              x: cx - EYE_R - LID_OVERSHOOT,
              y: EYE_CY - EYE_R - LID_OVERSHOOT,
              width: EYE_R * 2 + LID_OVERSHOOT * 2,
              height: EYE_R * 2 + LID_OVERSHOOT * 2,
            })
          )
        ),
        lidLine(cx, 'top'),
        lidLine(cx, 'bottom'),
        brow(cx, side)
      );
      body.setAttribute('clip-path', `url(#${clipId})`);
      return group;
    });
  }

  #restingPupilRadius(): number {
    const fill = Math.max(
      0,
      Math.min(100, Number.parseFloat(this.getAttribute('fill') ?? '0') || 0)
    );
    return PUPIL_R * fillToPupilScale(fill);
  }

  #syncTracking(): void {
    const shouldTrack =
      this.#eyeState() === 'open' &&
      !this.#motionQuery?.matches &&
      (this.#activity === null || this.#activity === 'working');
    if (shouldTrack && !this.#tracking) {
      this.ownerDocument.addEventListener('pointermove', this.#onPointerMove);
      this.#tracking = true;
    } else if (!shouldTrack) {
      this.#stopTracking();
      // Only the pointer-driven modes recentre; the auto-gaze modes own the pupils.
      if (this.#activity === null || this.#activity === 'working') this.#centerPupils();
    }
  }

  #stopTracking(): void {
    if (!this.#tracking) return;
    this.ownerDocument.removeEventListener('pointermove', this.#onPointerMove);
    this.#tracking = false;
  }

  #eyeState(): 'open' | 'dead' | 'none' | 'static' {
    const connection = this.getAttribute('connection');
    if (connection !== null && connection !== 'connected') return 'static';
    const eyes = this.getAttribute('eyes');
    if (eyes === 'dead' || eyes === 'none' || eyes === 'static') return eyes;
    return 'open';
  }

  // ── expression engine ────────────────────────────────────────────────────

  /** Reduced motion, TV static and dead/absent eyes all mean "no animation". */
  #instant(): boolean {
    return (
      this.#motionQuery?.matches === true ||
      this.#eyeState() !== 'open' ||
      !this.isConnected ||
      !this.#primed
    );
  }

  /** Static outranks everything: motion here would fake liveness the agent lacks. */
  #frozen(): boolean {
    return this.#eyeState() !== 'open';
  }

  #syncActivity(): void {
    const next = parseActivity(this.getAttribute('activity'));
    const wasExpressive = this.#root.querySelector('.avatar[data-expressive]') !== null;
    // Entering `awaiting` starts the drowse clock; leaving it stops the clock.
    if (next === 'awaiting' && this.#activity !== 'awaiting')
      this.#awaitingSince = performance.now();
    else if (next !== 'awaiting') this.#awaitingSince = 0;
    this.#anchorAt = 0;
    this.#activity = next;
    if (this.#expressive() !== wasExpressive) this.#render();
    this.#syncTracking();
    this.#syncEngine();
  }

  #syncEngine(): void {
    if (!this.#expressive() || !this.isConnected) {
      this.#stopEngine();
      return;
    }
    if (this.#frozen() || this.#motionQuery?.matches) {
      this.#stopFrames();
      this.#stopIdleBlinks();
      this.#settle();
      return;
    }
    this.#scheduleIdleBlinks();
    this.#startFrames();
  }

  #stopIdleBlinks(): void {
    for (const interval of this.#blinkIntervals) window.clearInterval(interval);
    this.#blinkIntervals = [];
  }

  #refresh(): void {
    if (!this.#expressive()) {
      this.#forced = true;
      if (this.isConnected) this.#render();
    }
    this.#syncEngine();
  }

  #startFrames(): void {
    if (this.#frame !== null) return;
    this.#lastStep = performance.now();
    this.#frame = window.requestAnimationFrame(this.#step);
  }

  #stopFrames(): void {
    if (this.#frame === null) return;
    window.cancelAnimationFrame(this.#frame);
    this.#frame = null;
  }

  #stopEngine(): void {
    this.#stopFrames();
    for (const timer of this.#blinkTimers) window.clearTimeout(timer);
    this.#blinkTimers = [];
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    for (const interval of this.#blinkIntervals) window.clearInterval(interval);
    this.#blinkIntervals = [];
  }

  readonly #step = (now: number): void => {
    this.#frame = window.requestAnimationFrame(this.#step);
    const dt = Math.min(0.05, Math.max(0, (now - this.#lastStep) / 1000));
    this.#lastStep = now;
    this.#integrate(now, dt);
    this.#apply();
  };

  #integrate(now: number, dt: number): void {
    const target = shapeTargetFor(this.#activity);
    if (target !== this.#shapeCommitted && !this.#committing) this.#commitShape(target);
    this.#shape = approach(this.#shape, this.#shapeCommitted, SHAPE_EASE, dt);
    this.#lidTop = approach(this.#lidTop, this.#lidTopTarget(now, false), LID_EASE, dt);
    this.#lidBottom = approach(this.#lidBottom, this.#lidBottomTarget(now), LID_EASE, dt);
    this.#advanceGaze(now, dt);
  }

  /** Reduced motion / static: jump every scalar to its target, no integrator. */
  #settle(): void {
    const now = performance.now();
    if (!this.#frozen()) {
      this.#shapeCommitted = this.#shape = shapeTargetFor(this.#activity);
      this.#lidTop = this.#lidTopTarget(now, true);
      this.#lidBottom = this.#lidBottomTarget(now);
      this.#settleGaze();
    }
    this.#apply();
    this.#scheduleSettle(now);
  }

  /** Under reduced motion the transient lids still need an expiry to land on. */
  #scheduleSettle(now: number): void {
    if (this.#settleTimer !== null) window.clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
    if (this.#frozen()) return;
    const drowseAt =
      this.#activity === 'awaiting' && this.#awaitingSince > 0
        ? this.#awaitingSince + this.drowseDelay * 1000
        : Number.POSITIVE_INFINITY;
    const next = Math.min(
      this.#glowerUntil > now ? this.#glowerUntil : Number.POSITIVE_INFINITY,
      this.#scrutinyUntil > now ? this.#scrutinyUntil : Number.POSITIVE_INFINITY,
      drowseAt > now ? drowseAt : Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(next)) return;
    this.#settleTimer = window.setTimeout(() => this.#settle(), Math.max(0, next - now) + 1);
  }

  #lidTopTarget(now: number, settled: boolean): number {
    const glower = this.#glowerUntil > now ? GLOWER_LID : 0;
    if (this.#activity !== 'awaiting') return glower;
    const elapsed = this.#awaitingSince > 0 ? (now - this.#awaitingSince) / 1000 : 0;
    const delay = this.drowseDelay;
    // Settled mode jumps straight past the 12 s ramp — the descent IS the motion.
    return Math.max(
      glower,
      drowseLid(settled && elapsed > delay ? delay + DROWSE_RAMP_S : elapsed, delay)
    );
  }

  #lidBottomTarget(now: number): number {
    return this.#scrutinyUntil > now ? SCRUTINY_LID : 0;
  }

  #commitShape(target: number): void {
    if (this.#instant()) {
      this.#shapeCommitted = this.#shape = target;
      return;
    }
    // The blink-gate: creatures don't reshape in front of you — they blink, and
    // they're different. The swap lands at the apex, behind a closed lid.
    this.#committing = true;
    this.#blinkBoth(() => {
      this.#shapeCommitted = this.#shape = target;
      this.#committing = false;
    });
  }

  #eyeGroups(): SVGGElement[] {
    return [...this.#root.querySelectorAll<SVGGElement>('.eye-blink')];
  }

  #blinkBoth(apex?: () => void): void {
    const groups = this.#eyeGroups();
    if (groups.length === 0) {
      apex?.();
      return;
    }
    groups.forEach((group, index) => {
      this.#blinkGroup(group, index === 0 ? apex : undefined);
    });
  }

  #blinkGroup(group: SVGGElement, apex?: () => void): void {
    group.style.transition = `transform ${BLINK_IN_MS}ms ease-in`;
    group.style.transform = `scaleY(${BLINK_SQUISH})`;
    this.#blinkTimers.push(
      window.setTimeout(() => {
        apex?.();
        if (this.#activity === 'thinking' && !this.#frozen())
          this.#brows = recockBrows(this.#brows);
        group.style.transition = `transform ${BLINK_OUT_MS}ms ease-out`;
        group.style.transform = 'scaleY(1)';
      }, BLINK_APEX_MS)
    );
  }

  /**
   * The engine drives its own idle blinks so a commit can land at the apex.
   * `blink` is deliberately NOT an observed attribute, so the gate is re-read
   * when each interval fires rather than when the interval is scheduled.
   */
  #scheduleIdleBlinks(): void {
    if (this.#blinkIntervals.length > 0 || this.#instant() || this.#frozen()) return;
    const periods = [BLINK_PERIOD_LEFT_MS, BLINK_PERIOD_RIGHT_MS];
    periods.forEach((period, index) => {
      this.#blinkIntervals.push(
        window.setInterval(() => {
          const group = this.#eyeGroups()[index];
          if (group && this.hasAttribute('blink') && !this.#frozen()) this.#blinkGroup(group);
        }, period)
      );
    });
  }

  // ── gaze ─────────────────────────────────────────────────────────────────

  #autoGaze(now: number): { target: GazePoint; rate: number } | null {
    if (this.#activity === 'thinking') {
      return { target: this.#hop(now, SACCADE_TARGETS, SACCADE_INTERVAL_MS), rate: SACCADE_EASE };
    }
    if (this.#activity === 'idle') {
      return { target: this.#hop(now, WANDER_TARGETS, WANDER_INTERVAL_MS), rate: WANDER_EASE };
    }
    if (this.#activity === 'awaiting') {
      return { target: this.#resolveAnchor(now), rate: ANCHOR_EASE };
    }
    return null;
  }

  #hop(now: number, targets: readonly GazePoint[], interval: number): GazePoint {
    if (now - this.#gazeChangedAt > interval) {
      this.#gazeChangedAt = now;
      this.#gazeIndex = nextGazeIndex(this.#gazeIndex, targets.length, Math.random);
    }
    return targets[this.#gazeIndex] ?? REST_GAZE;
  }

  #advanceGaze(now: number, dt: number): void {
    const auto = this.#autoGaze(now);
    if (!auto) return;
    this.#gaze = {
      x: approach(this.#gaze.x, auto.target.x, auto.rate, dt),
      y: approach(this.#gaze.y, auto.target.y, auto.rate, dt),
    };
    this.#placePupils();
  }

  #settleGaze(): void {
    // Reduced motion keeps eye contact (a point, not motion) but drops the
    // saccades and the lazy wander entirely — those eyes just look straight out.
    if (this.#activity === 'awaiting') {
      this.#gaze = this.#resolveAnchor(performance.now());
      this.#placePupils();
    } else if (this.#activity === 'thinking' || this.#activity === 'idle') {
      this.#centerPupils();
    }
  }

  #placePupils(): void {
    if (this.#pupilL) place(this.#pupilL, LEFT_EYE.cx, this.#gaze.x, this.#gaze.y, this.#maxOffset);
    if (this.#pupilR)
      place(this.#pupilR, RIGHT_EYE.cx, this.#gaze.x, this.#gaze.y, this.#maxOffset);
  }

  /**
   * Resolve the `gaze-target` selector to a band-space point. Reading the
   * target's box is a layout read, so it is throttled — never a per-frame cost.
   */
  #resolveAnchor(now: number): GazePoint {
    if (now - this.#anchorAt < ANCHOR_REFRESH_MS) return this.#anchor;
    this.#anchorAt = now;
    const selector = this.getAttribute('gaze-target');
    const target = selector ? this.ownerDocument.querySelector(selector) : null;
    const bounds = this.#eyesSvg?.getBoundingClientRect();
    if (!target || !bounds?.width || !bounds.height) {
      this.#anchor = REST_GAZE;
      return this.#anchor;
    }
    const box = target.getBoundingClientRect();
    this.#anchor = {
      x: (box.left + box.width / 2 - bounds.left) * (200 / bounds.width),
      y: (box.top + box.height / 2 - bounds.top) * (100 / bounds.height),
    };
    return this.#anchor;
  }

  // ── paint ────────────────────────────────────────────────────────────────

  #browsVisible(): boolean {
    return this.#activity === 'thinking';
  }

  #apply(): void {
    const now = performance.now();
    const shape = this.#shape;
    const rx = socketRx(shape);
    const radius = this.#restingPupilRadius() * popScale(this.#popUntil - now);
    this.#pupilRadius = radius;
    this.#maxOffset = travelClamp(radius);
    for (const [index, side] of (['l', 'r'] as const).entries()) {
      const cx = index === 0 ? LEFT_EYE.cx : RIGHT_EYE.cx;
      this.#applySockets(side, rx);
      this.#applyPupil(side, cx, radius, shape);
      this.#applyLids(side, cx, shape);
      this.#applyBrow(side);
    }
  }

  #applySockets(side: 'l' | 'r', rx: number): void {
    for (const shapeEl of this.#root.querySelectorAll(
      `.eye-body-${side} .socket, .eye-body-${side} .eye-outline, .eye-body-${side} .noise-clip`
    )) {
      setNumber(shapeEl, 'rx', rx);
    }
  }

  #applyPupil(side: 'l' | 'r', cx: number, radius: number, shape: number): void {
    const rect = this.#root.querySelector(`.pupil-${side} rect`);
    if (!rect) return;
    setNumber(rect, 'x', cx - radius);
    setNumber(rect, 'y', EYE_CY - radius);
    setNumber(rect, 'width', radius * 2);
    setNumber(rect, 'height', radius * 2);
    setNumber(rect, 'rx', pupilRx(radius, shape));
    const highlight = this.#root.querySelector(`.pupil-${side} circle`);
    setNumber(highlight, 'cx', cx - radius * 0.3);
    setNumber(highlight, 'cy', EYE_CY - radius * 0.35);
    setNumber(highlight, 'r', radius * 0.4);
  }

  #applyLids(side: 'l' | 'r', cx: number, shape: number): void {
    const clip = this.#root.querySelector(`.eye-${side} .lid-clip`);
    if (!clip) return;
    const top = topLidY(this.#lidTop);
    const bottom = bottomLidY(this.#lidBottom);
    setNumber(clip, 'y', top);
    setNumber(clip, 'height', Math.max(0, bottom - top));
    this.#applyChord(`.eye-${side} .lid-top`, cx, top, shape, this.#lidTop);
    this.#applyChord(`.eye-${side} .lid-bottom`, cx, bottom, shape, this.#lidBottom);
  }

  #applyChord(selector: string, cx: number, y: number, shape: number, fraction: number): void {
    const line = this.#root.querySelector(selector);
    if (!line) return;
    const half = chordHalfWidth(y, shape);
    setNumber(line, 'x1', cx - half);
    setNumber(line, 'x2', cx + half);
    setNumber(line, 'y1', y);
    setNumber(line, 'y2', y);
    setAttr(line, 'display', fraction > LID_LINE_EPSILON ? 'inline' : 'none');
  }

  #applyBrow(side: 'l' | 'r'): void {
    const line = this.#root.querySelector<SVGLineElement>(`.brow-${side}`);
    if (!line) return;
    const visible = this.#browsVisible();
    const pose = side === 'l' ? this.#brows.left : this.#brows.right;
    setAttr(line, 'opacity', visible ? '1' : '0');
    line.style.transform = visible
      ? `translateY(${pose.raise.toFixed(2)}px) rotate(${pose.tilt.toFixed(2)}deg)`
      : 'translateY(6px)';
  }

  // ── static noise (connection channel) ────────────────────────────────────

  #startNoise(): void {
    this.#stopNoise();
    if (this.#noiseCells.length === 0) this.#prepareNoiseCells();
    if (this.#motionQuery?.matches) {
      this.#paintNoise(null);
      return;
    }
    this.#paintNoise(currentNoiseFrame());
    this.#noiseInterval = window.setInterval(() => {
      this.#paintNoise(currentNoiseFrame());
    }, 1000 / NOISE_FPS);
  }

  #prepareNoiseCells(): void {
    const bounds = this.#eyesSvg?.getBoundingClientRect();
    const renderedScale = bounds ? Math.min(bounds.width / 200, bounds.height / 100) : 0;
    const cellSize = NOISE_CELL_SIZE / (renderedScale > 0 ? renderedScale : 0.25);
    this.#noiseCells = [...this.#root.querySelectorAll<SVGGElement>('.noise')].map(
      (group, eyeIndex) => {
        const cx = eyeIndex === 0 ? LEFT_EYE.cx : RIGHT_EYE.cx;
        const cells: SVGRectElement[] = [];
        const minX = cx - LEFT_EYE.r;
        const maxX = cx + LEFT_EYE.r;
        const minY = EYE_CY - LEFT_EYE.r;
        const maxY = EYE_CY + LEFT_EYE.r;
        for (let y = minY; y < maxY; y += cellSize) {
          for (let x = minX; x < maxX; x += cellSize) {
            const cell = svgEl('rect', {
              x,
              y,
              width: Math.min(cellSize, maxX - x),
              height: Math.min(cellSize, maxY - y),
              opacity: NOISE_OPACITY,
            });
            cells.push(cell);
          }
        }
        group.replaceChildren(...cells);
        return cells;
      }
    );
  }

  #paintNoise(frame: number | null): void {
    this.#noiseCells.forEach((cells, eyeIndex) => {
      const seed = frame === null ? frozenNoiseSeed(eyeIndex) : animatedNoiseSeed(eyeIndex, frame);
      let state = seed === 0 ? FROZEN_NOISE_SEED : seed;
      const group = cells[0]?.parentElement;
      group?.setAttribute('data-seed', String(state));
      for (const cell of cells) {
        state = xorshift32(state);
        const luminance = NOISE_LUMINANCE[state % NOISE_LUMINANCE.length];
        const channel = `${luminance * 100}%`;
        cell.setAttribute('fill', `rgb(${channel} ${channel} ${channel})`);
      }
    });
  }

  #stopNoise(): void {
    if (this.#noiseInterval === null) return;
    window.clearInterval(this.#noiseInterval);
    this.#noiseInterval = null;
  }

  #centerPupils(): void {
    this.#pupilL?.setAttribute('transform', 'translate(0,0)');
    this.#pupilR?.setAttribute('transform', 'translate(0,0)');
  }

  #track(event: PointerEvent): void {
    if (!this.#eyesSvg || !this.#pupilL || !this.#pupilR) return;
    const bounds = this.#eyesSvg.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    this.#gaze = {
      x: (event.clientX - bounds.left) * (200 / bounds.width),
      y: (event.clientY - bounds.top) * (100 / bounds.height),
    };
    this.#placePupils();
  }
}

define('slicc-agent-avatar', SliccAgentAvatar);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-agent-avatar': SliccAgentAvatar;
  }
}
