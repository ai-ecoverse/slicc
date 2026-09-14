import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import {
  attachLongPressGesture,
  LONG_PRESS_MS,
  type LongPressHandle,
} from '../internal/long-press.js';

const STYLE = `
slicc-press-button {
  display: inline-flex;
}
.slicc-press-btn__btn {
  appearance: none;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  position: relative;
}
.slicc-press-btn__btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.slicc-press-btn__press-layer {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}
.slicc-press-btn__btn > :not(.slicc-press-btn__press-layer) {
  position: relative;
  z-index: 1;
}
.slicc-press-btn__press {
  position: absolute;
  border-radius: 50%;
  background: var(--press-ripple, var(--ctx));
  opacity: 0.85;
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition-property: width, height;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  will-change: width, height;
}
/*
 * Click / double-click delight animations. Toggled as classes on the inner
 * <button> from JS and removed on \`animationend\` (so they re-fire every press
 * and stay testable). \`transform-origin: center\` keeps the squish/wobble
 * pivoting around the button's middle.
 *
 * Single press → a quick tactile "squish" (scale down and spring back).
 * Double press → a distinct playful "wobble" (a side-to-side rubber-band tilt).
 */
.slicc-press-btn__btn {
  transform-origin: center;
}
.slicc-press-btn__btn.is-squish {
  animation: slicc-press-squish 220ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.slicc-press-btn__btn.is-wobble {
  animation: slicc-press-wobble 520ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}
@keyframes slicc-press-squish {
  0% { transform: scale(1); }
  35% { transform: scale(0.82); }
  70% { transform: scale(1.06); }
  100% { transform: scale(1); }
}
@keyframes slicc-press-wobble {
  0% { transform: rotate(0deg) scale(1); }
  15% { transform: rotate(-9deg) scale(1.08); }
  30% { transform: rotate(7deg) scale(1.08); }
  45% { transform: rotate(-5deg) scale(1.04); }
  60% { transform: rotate(3deg) scale(1.02); }
  75% { transform: rotate(-1.5deg) scale(1.01); }
  100% { transform: rotate(0deg) scale(1); }
}
/*
 * Respect prefers-reduced-motion: no animation, hold the static end state.
 * The classes may still be toggled by JS (events are unaffected) but paint
 * nothing — the button stays put.
 */
@media (prefers-reduced-motion: reduce) {
  .slicc-press-btn__btn.is-squish,
  .slicc-press-btn__btn.is-wobble {
    animation: none;
  }
}
`;

const STYLE_ID = 'slicc-press-button-style';

function ensurePressButtonStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export const DEFAULT_DOUBLE_CLICK_MS = 350;

const BASE = 'slicc-press-btn';

export const SQUISH_CLASS = 'is-squish';
export const WOBBLE_CLASS = 'is-wobble';

export class SliccPressButton extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['label', 'tooltip', 'tooltip-pos', 'disabled'];
  }

  private innerBtn: HTMLButtonElement | null = null;
  private pressLayer: HTMLSpanElement | null = null;
  private handle: LongPressHandle | null = null;
  private initialized = false;
  private pendingShortTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShortEvent: MouseEvent | null = null;

  private animEndListener: ((e: AnimationEvent) => void) | null = null;

  connectedCallback(): void {
    ensurePressButtonStyle(this.ownerDocument);
    if (!this.initialized) {
      this.initialize();
    } else if (this.handle === null) {
      this.attachGesture();
    }
    this.syncAttributes();
  }

  disconnectedCallback(): void {
    this.handle?.destroy();
    this.handle = null;
    this.clearPendingShort();
    this.clearRipple();

    this.clearAnimation();
  }

  attributeChangedCallback(): void {
    if (!this.initialized) return;
    this.syncAttributes();
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', value);
  }

  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  get tooltip(): string | null {
    return this.getAttribute('tooltip');
  }

  set tooltip(value: string | null) {
    if (value == null) this.removeAttribute('tooltip');
    else this.setAttribute('tooltip', value);
  }

  setIcon(html: string): void {
    if (!this.initialized) this.initialize();
    const btn = this.innerBtn!;
    const layer = this.pressLayer!;
    for (const child of Array.from(btn.childNodes)) {
      if (child !== layer) child.remove();
    }
    const parsed = new DOMParser().parseFromString(html, 'text/html').body;
    while (parsed.firstChild) btn.appendChild(parsed.firstChild);
  }

  override focus(options?: FocusOptions): void {
    if (!this.initialized) this.initialize();
    this.innerBtn?.focus(options);
  }

  private initialize(): void {
    this.initialized = true;

    const layer = h('span', {
      class: `${BASE}__press-layer`,
      part: 'press-layer',
    }) as HTMLSpanElement;
    const btn = h(
      'button',
      { type: 'button', class: `${BASE}__btn`, part: 'button' },
      layer
    ) as HTMLButtonElement;

    while (this.firstChild) btn.appendChild(this.firstChild);

    this.appendChild(btn);
    this.innerBtn = btn;
    this.pressLayer = layer;

    this.attachGesture();
  }

  private syncAttributes(): void {
    const btn = this.innerBtn;
    if (!btn) return;

    const label = this.getAttribute('label');
    if (label != null) btn.setAttribute('aria-label', label);
    else btn.removeAttribute('aria-label');

    const tooltip = this.getAttribute('tooltip');
    if (tooltip != null) btn.dataset.tooltip = tooltip;
    else delete btn.dataset.tooltip;

    const tooltipPos = this.getAttribute('tooltip-pos');
    if (tooltipPos != null) btn.dataset.tooltipPos = tooltipPos;
    else delete btn.dataset.tooltipPos;

    if (this.hasAttribute('disabled')) btn.setAttribute('disabled', '');
    else btn.removeAttribute('disabled');
  }

  private longPressMs(): number {
    const raw = this.getAttribute('long-press-ms');
    if (raw == null) return LONG_PRESS_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : LONG_PRESS_MS;
  }

  private doubleClickMs(): number {
    const raw = this.getAttribute('double-click-ms');
    if (raw == null) return DEFAULT_DOUBLE_CLICK_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DOUBLE_CLICK_MS;
  }

  private doubleClickDisabled(): boolean {
    return this.hasAttribute('disable-double-click');
  }

  private emit(type: 'short-click' | 'long-press' | 'double-click', source?: MouseEvent): void {
    if (type === 'short-click') this.playAnimation(SQUISH_CLASS);
    else if (type === 'double-click') this.playAnimation(WOBBLE_CLASS);

    const detail = source ? { sourceEvent: source } : {};
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail }));
  }

  private playAnimation(cls: typeof SQUISH_CLASS | typeof WOBBLE_CLASS): void {
    const btn = this.innerBtn;
    if (!btn) return;

    this.clearAnimation();

    void btn.offsetWidth;
    btn.classList.add(cls);
    const onEnd = (e: AnimationEvent): void => {
      if (e.target !== btn) return;
      this.clearAnimation();
    };
    this.animEndListener = onEnd;
    btn.addEventListener('animationend', onEnd);
  }

  private clearAnimation(): void {
    const btn = this.innerBtn;
    if (!btn) return;
    if (this.animEndListener) {
      btn.removeEventListener('animationend', this.animEndListener);
      this.animEndListener = null;
    }
    btn.classList.remove(SQUISH_CLASS, WOBBLE_CLASS);
  }

  private clearPendingShort(): void {
    if (this.pendingShortTimer !== null) {
      clearTimeout(this.pendingShortTimer);
      this.pendingShortTimer = null;
    }
    this.pendingShortEvent = null;
  }

  private attachGesture(): void {
    this.handle = attachLongPressGesture(this, {
      longPressMs: this.longPressMs(),
      onPressStart: (e) => this.paintRipple(e),
      onPressEnd: () => this.clearRipple(),
      onLongPress: () => {
        if (this.pendingShortTimer !== null) {
          this.clearPendingShort();
          this.emit('double-click');
          return;
        }
        this.emit('long-press');
      },
      onShortClick: (e) => {
        if (this.doubleClickDisabled()) {
          this.emit('short-click', e);
          return;
        }
        if (this.pendingShortTimer !== null) {
          this.clearPendingShort();
          this.emit('double-click', e);
          return;
        }

        this.pendingShortEvent = e;
        this.pendingShortTimer = setTimeout(() => {
          this.pendingShortTimer = null;
          const ev = this.pendingShortEvent;
          this.pendingShortEvent = null;
          this.emit('short-click', ev ?? undefined);
        }, this.doubleClickMs());
      },
    });
  }

  private paintRipple(e: MouseEvent): void {
    this.clearRipple();
    const layer = this.pressLayer;
    if (!layer) return;

    const rect = layer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const farthestX = Math.max(x, rect.width - x);
    const farthestY = Math.max(y, rect.height - y);
    const radius = Math.ceil(Math.hypot(farthestX, farthestY)) + 2;
    const span = this.ownerDocument.createElement('span');
    span.className = `${BASE}__press`;
    span.style.left = `${x}px`;
    span.style.top = `${y}px`;
    span.style.width = '0px';
    span.style.height = '0px';
    span.style.transitionDuration = `${this.longPressMs()}ms`;
    layer.appendChild(span);
    requestAnimationFrame(() => {
      if (!span.isConnected) return;
      span.style.width = `${radius * 2}px`;
      span.style.height = `${radius * 2}px`;
    });
  }

  private clearRipple(): void {
    const layer = this.pressLayer;
    if (!layer) return;
    while (layer.firstChild) layer.firstChild.remove();
  }
}

define('slicc-press-button', SliccPressButton);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-press-button': SliccPressButton;
  }
}
