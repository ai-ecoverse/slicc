import { define } from '../internal/define.js';

/**
 * Default eye diameter in pixels, lifted verbatim from the prototype's `.eye`
 * rule (`width:9px;height:9px`). The `size` attribute scales every derived
 * length (border width, pupil offset clamp) proportionally off this base.
 */
const BASE_SIZE = 9;

/** Maximum pupil travel in CSS pixels (prototype: `Math.min(3, …)`). */
const MAX_OFFSET = 3;

/** Distance divisor that maps cursor distance → pupil travel (prototype: `/45`). */
const DISTANCE_DIVISOR = 45;

/**
 * Per-instance stylesheet for `<slicc-googly-eyes>`.
 *
 * Faithful to the prototype `.eyes` / `.eye` / `.eye::after` rules
 * (StellarRubySwift.html): a 9×9 white sclera with a 1.3px black border and a
 * 42%×42% black pupil pseudo-element positioned at left 50% / top 55% and
 * translated by `--px` / `--py`. The inverted variant mirrors the prototype's
 * `.scoop.active` treatment (white border + white pupil). Colors are fixed
 * `#fff` sclera / `#000` pupil (NOT theme-driven) per the component contract;
 * `inverted` is a variant, not a dark-mode response.
 */
const STYLE = `
:host {
  display: inline-flex;
  align-items: center;
  line-height: 1;
  /* size scales the whole rig; 1.3px border at the 9px base. */
  --_eye: 9px;
  --_border: 1.3px;
}
.eyes {
  display: inline-flex;
  gap: 3px;
}
.eye {
  width: var(--_eye);
  height: var(--_eye);
  border-radius: 50%;
  background: #fff;
  border: var(--_border) solid #000;
  position: relative;
  display: inline-block;
  box-sizing: border-box;
  /* Eyelid pivot is the eye centre so the lid closes top-and-bottom. */
  transform-origin: center;
}
.eye::after {
  content: "";
  position: absolute;
  width: 42%;
  height: 42%;
  border-radius: 50%;
  background: #000;
  left: 50%;
  top: 55%;
  transform: translate(calc(-50% + var(--px, 0px)), calc(-50% + var(--py, 0px)));
}
/* Inverted variant — white border + white pupil (prototype .scoop.active). */
:host([inverted]) .eye { border-color: #fff; }
:host([inverted]) .eye::after { background: #fff; }
/* Dead state — replace the pupil with an "X" glyph centered in the sclera. */
:host([eyes="dead"]) .eye::after { display: none; }
.x {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--ui), system-ui, sans-serif;
  font-weight: 700;
  font-size: calc(var(--_eye) * 0.85);
  line-height: 1;
  color: #000;
  /* nudge onto the sclera centre to mirror the live pupil's top:55% bias */
  transform: translateY(3%);
  user-select: none;
}
:host([inverted]) .x { color: #fff; }

/*
 * Blinking — the eyelid closes briefly then reopens on a slow loop. Squashing
 * the eye's vertical scale to ~0.1 reads as a blink; because the pupil
 * (.eye::after) is a child, it squashes with the lid, while its own --px/--py
 * translate keeps composing with cursor-tracking. The two eyes use slightly
 * different cycle lengths (~3.4s / ~4.6s) so the loop lands in the 3-5s band
 * and never feels metronomic. Dead eyes (no live pupil) never blink.
 */
@keyframes slicc-eye-blink {
  /* The lid is open for the vast majority of the cycle; the brief dip lives in
     the last few percent. The 95%->97.5%->100% close+reopen spans ~5% of the
     cycle: ~170ms at 3.4s and ~230ms at 4.6s — a quick, natural blink. */
  0%, 95%, 100% { transform: scaleY(1); }
  97.5% { transform: scaleY(0.1); }
}
:host([blink]:not([eyes="dead"])) .eye {
  animation: slicc-eye-blink 3.4s ease-in-out infinite;
}
:host([blink]:not([eyes="dead"])) [part~="eye-right"] {
  animation-duration: 4.6s;
}
@media (prefers-reduced-motion: reduce) {
  :host([blink]) .eye { animation: none; }
}
`;

/**
 * `<slicc-googly-eyes>` — the wiggly scoop-avatar eyes from the prototype
 * (`.eyes` / `.eye` / `.eye::after`). A pair of 9×9 white circles whose black
 * pupils track the cursor via per-eye `atan2`/`hypot` math driving the
 * `--px` / `--py` custom properties. Self-contained shadow DOM with a built-in
 * document `mousemove` listener — it does NOT depend on the prototype's
 * page-level script. Colors are fixed (`#fff` sclera / `#000` pupil); the
 * `inverted` variant flips them to white-on-transparent.
 *
 * The optional `blink` attribute layers a slow CSS-only eyelid blink on top of
 * the live pupil tracking: the eye's `scaleY` squashes to ~0.1 for ~120ms on a
 * 3–5s loop (the two eyes run at slightly different cycle lengths so the blink
 * never feels metronomic). It composes with cursor-tracking — the pupil squashes
 * with the lid while still following the `--px`/`--py` translate — and no-ops
 * under `prefers-reduced-motion: reduce` and in the `dead` state.
 *
 * @attr inverted - boolean; white border + white pupil (for dark/active chrome)
 * @attr tracking - boolean; pupils follow the cursor. Defaults to ON; remove or
 *   set `tracking="off"` to centre the pupils (idle).
 * @attr blink - boolean; periodic eyelid blink (CSS @keyframes `scaleY`). No-op
 *   under reduced-motion and when `eyes="dead"`.
 * @attr eyes - `open` (default) | `dead` (renders "X X")
 * @attr size - eye diameter in CSS pixels (default 9)
 * @csspart eyes - the inline-flex container holding both eyes
 * @csspart eye - both eye circles (style with `part="eye"`)
 * @csspart eye-left - the left eye circle
 * @csspart eye-right - the right eye circle
 * @csspart pupil - alias kept for symmetry; the pupil is the `.eye::after`
 * @slot - optional adornment rendered between the two eyes (e.g. a nose)
 */
export class SliccGooglyEyes extends HTMLElement {
  static readonly observedAttributes = ['inverted', 'tracking', 'blink', 'eyes', 'size'];

  readonly #root: ShadowRoot;
  #eyeNodes: HTMLElement[] = [];
  #onMove: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    this.#render();
    this.#syncTracking();
  }

  disconnectedCallback(): void {
    this.#stopTracking();
  }

  attributeChangedCallback(name: string, _old: string | null, _next: string | null): void {
    if (!this.isConnected) return;
    if (name === 'size' || name === 'eyes') {
      this.#render();
      this.#syncTracking();
    } else if (name === 'tracking') {
      this.#syncTracking();
    } else {
      // `inverted` and `blink` are pure CSS (:host([inverted]) /
      // :host([blink])); nothing to re-render.
    }
  }

  /** White border + white pupil variant. */
  get inverted(): boolean {
    return this.hasAttribute('inverted');
  }

  set inverted(value: boolean) {
    this.toggleAttribute('inverted', value);
  }

  /**
   * Whether pupils follow the cursor. Defaults to `true`; the attribute is only
   * considered "off" when explicitly removed or set to the string `"off"`.
   */
  get tracking(): boolean {
    const attr = this.getAttribute('tracking');
    return attr !== 'off';
  }

  set tracking(value: boolean) {
    if (value) this.setAttribute('tracking', 'on');
    else this.setAttribute('tracking', 'off');
  }

  /**
   * Whether the eyes periodically blink (CSS-only eyelid `scaleY` animation).
   * No-op under `prefers-reduced-motion: reduce` and in the `dead` state.
   */
  get blink(): boolean {
    return this.hasAttribute('blink');
  }

  set blink(value: boolean) {
    this.toggleAttribute('blink', value);
  }

  /** Eye state: `open` (cursor-tracking pupils) or `dead` ("X X"). */
  get eyes(): 'open' | 'dead' {
    return this.getAttribute('eyes') === 'dead' ? 'dead' : 'open';
  }

  set eyes(value: 'open' | 'dead') {
    this.setAttribute('eyes', value === 'dead' ? 'dead' : 'open');
  }

  /** Eye diameter in CSS pixels. Falls back to the prototype's 9px base. */
  get size(): number {
    const raw = Number.parseFloat(this.getAttribute('size') ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : BASE_SIZE;
  }

  set size(value: number) {
    this.setAttribute('size', String(value));
  }

  #render(): void {
    const size = this.size;
    const border = (1.3 / BASE_SIZE) * size;
    const dead = this.eyes === 'dead';
    const inner = dead ? '<span class="x" aria-hidden="true">×</span>' : '';
    this.#root.innerHTML =
      `<style>${STYLE}</style>` +
      `<span class="eyes" part="eyes" style="--_eye:${size}px;--_border:${border}px" role="img" aria-label="${dead ? 'dead eyes' : 'googly eyes'}">` +
      `<span class="eye" part="eye eye-left">${inner}</span>` +
      '<slot></slot>' +
      `<span class="eye" part="eye eye-right">${inner}</span>` +
      '</span>';
    this.#eyeNodes = Array.from(this.#root.querySelectorAll<HTMLElement>('.eye'));
    this.#center();
  }

  /** Attach or detach the document mousemove listener to match current state. */
  #syncTracking(): void {
    const active = this.tracking && this.eyes === 'open';
    if (active) this.#startTracking();
    else {
      this.#stopTracking();
      this.#center();
    }
  }

  #startTracking(): void {
    if (this.#onMove) return;
    this.#onMove = (e: MouseEvent) => this.#track(e);
    document.addEventListener('mousemove', this.#onMove);
  }

  #stopTracking(): void {
    if (!this.#onMove) return;
    document.removeEventListener('mousemove', this.#onMove);
    this.#onMove = null;
  }

  /** Reset both pupils to centre (idle). */
  #center(): void {
    for (const eye of this.#eyeNodes) {
      eye.style.setProperty('--px', '0px');
      eye.style.setProperty('--py', '0px');
    }
  }

  /**
   * Per-eye pupil placement — faithful to the prototype's page script: angle
   * via `atan2`, distance via `hypot` clamped to 3px and divided by 45, then
   * `cos`/`sin` projected onto `--px` / `--py`.
   */
  #track(e: MouseEvent): void {
    for (const eye of this.#eyeNodes) {
      const r = eye.getBoundingClientRect();
      const ex = r.left + r.width / 2;
      const ey = r.top + r.height / 2;
      const a = Math.atan2(e.clientY - ey, e.clientX - ex);
      const d = Math.min(MAX_OFFSET, Math.hypot(e.clientX - ex, e.clientY - ey) / DISTANCE_DIVISOR);
      eye.style.setProperty('--px', `${(Math.cos(a) * d).toFixed(2)}px`);
      eye.style.setProperty('--py', `${(Math.sin(a) * d).toFixed(2)}px`);
    }
  }
}

define('slicc-googly-eyes', SliccGooglyEyes);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-googly-eyes': SliccGooglyEyes;
  }
}
