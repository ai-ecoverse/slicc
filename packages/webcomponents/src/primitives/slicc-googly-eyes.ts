import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

const BASE_SIZE = 9;

const MAX_OFFSET = 3;

const DISTANCE_DIVISOR = 45;

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

const SHEET = sheet(STYLE);

export class SliccGooglyEyes extends HTMLElement {
  static readonly observedAttributes = ['inverted', 'tracking', 'blink', 'eyes', 'size'];

  readonly #root: ShadowRoot;
  #eyeNodes: HTMLElement[] = [];
  #onMove: ((e: MouseEvent) => void) | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
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
    }
  }

  get inverted(): boolean {
    return this.hasAttribute('inverted');
  }

  set inverted(value: boolean) {
    this.toggleAttribute('inverted', value);
  }

  get tracking(): boolean {
    const attr = this.getAttribute('tracking');
    return attr !== 'off';
  }

  set tracking(value: boolean) {
    if (value) this.setAttribute('tracking', 'on');
    else this.setAttribute('tracking', 'off');
  }

  get blink(): boolean {
    return this.hasAttribute('blink');
  }

  set blink(value: boolean) {
    this.toggleAttribute('blink', value);
  }

  get eyes(): 'open' | 'dead' {
    return this.getAttribute('eyes') === 'dead' ? 'dead' : 'open';
  }

  set eyes(value: 'open' | 'dead') {
    this.setAttribute('eyes', value === 'dead' ? 'dead' : 'open');
  }

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

    const eye = (part: string): HTMLElement =>
      h(
        'span',
        { class: 'eye', part },
        dead ? h('span', { class: 'x', 'aria-hidden': 'true' }, '×') : null
      );
    const container = h(
      'span',
      {
        class: 'eyes',
        part: 'eyes',
        style: `--_eye:${size}px;--_border:${border}px`,
        role: 'img',
        'aria-label': dead ? 'dead eyes' : 'googly eyes',
      },
      eye('eye eye-left'),
      h('slot'),
      eye('eye eye-right')
    );
    this.#root.replaceChildren(container);
    this.#eyeNodes = Array.from(this.#root.querySelectorAll<HTMLElement>('.eye'));
    this.#center();
  }

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

  #center(): void {
    for (const eye of this.#eyeNodes) {
      eye.style.setProperty('--px', '0px');
      eye.style.setProperty('--py', '0px');
    }
  }

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
