import { define } from '../internal/define.js';
import {
  attachLongPressGesture,
  LONG_PRESS_MS,
  type LongPressHandle,
} from '../internal/long-press.js';

/**
 * Scoped, document-level stylesheet for `<slicc-press-button>`. A light-DOM
 * component can't carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the BEM
 * hooks below.
 *
 * Lifted from the webapp's `slicc-press-button` CSS
 * (`packages/webapp/src/ui/styles/tabs.css`): the host carries
 * `display:inline-flex` so the parent sizes it; the inner `<button>` fills the
 * host so the ripple's bounding rect matches what the user sees; the press
 * layer is clipped to the inherited border-radius; slotted icon content sits
 * above the ripple. The webapp painted the ripple with its `--s2-accent` token
 * — in this library the equivalent prototype accent is `--ctx`, exposed here as
 * the overridable `--press-ripple` so a host can retint per-instance.
 */
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

/** Inject the scoped press-button stylesheet into a document once (idempotent). */
function ensurePressButtonStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Default delay before committing a single click as a `short-click`. */
export const DEFAULT_DOUBLE_CLICK_MS = 350;

/** BEM-ish base class for the component's own DOM hooks. */
const BASE = 'slicc-press-btn';

/**
 * Animation hook classes toggled on the inner `<button>`. Exported so tests
 * (and curious hosts) can assert which delight animation a gesture triggered:
 * a single press squishes, a double-press wobbles. Each class is removed on
 * `animationend` so the next press re-fires it.
 */
export const SQUISH_CLASS = 'is-squish';
export const WOBBLE_CLASS = 'is-wobble';

/**
 * `<slicc-press-button>` — a reusable click + long-press + double-click button
 * with a flood-fill ripple, lifted verbatim from the webapp
 * (`packages/webapp/src/ui/press-button.ts` + `long-press.ts`). The side rail,
 * the thread-header new-session button, and the chat copy button all share this
 * one component.
 *
 * Light DOM (no shadow root): the host renders its own inner `<button>` + press
 * layer and relocates caller-supplied icon children into the button so they
 * render on top of the ripple. The host app styles it and slots content; the
 * scoped stylesheet (above) is injected once into the host document.
 *
 * Internal DOM (light DOM):
 *
 *     <slicc-press-button>
 *       <button class="slicc-press-btn__btn" type="button">
 *         <span class="slicc-press-btn__press-layer"></span>
 *         <!-- caller-supplied icon nodes (relocated at connect time) -->
 *       </button>
 *     </slicc-press-button>
 *
 * Visual + sizing: the host carries `display: inline-flex` so it can be sized by
 * its parent (rail item, header button, copy button). The inner button fills the
 * host (`width/height: 100%`) so the ripple's bounding rect matches what the
 * user sees as "the button".
 *
 * Delight animations: alongside the ripple, the inner button plays a quick
 * tactile **squish** ({@link SQUISH_CLASS}) on a committed single press and a
 * distinct playful **wobble** ({@link WOBBLE_CLASS}) on a double-press. The
 * classes are toggled in JS and self-remove on `animationend`, so they re-fire
 * on every press and stay assertable. Both no-op under
 * `prefers-reduced-motion: reduce` (the CSS holds the static end state).
 *
 * @attr label - forwarded to the inner button's `aria-label`
 * @attr tooltip - forwarded to the inner button's `data-tooltip`
 * @attr tooltip-pos - forwarded to the inner button's `data-tooltip-pos`
 * @attr disabled - boolean; disables the inner button
 * @attr long-press-ms - long-press threshold in ms (default {@link LONG_PRESS_MS})
 * @attr double-click-ms - double-click window in ms (default {@link DEFAULT_DOUBLE_CLICK_MS})
 * @attr disable-double-click - boolean; fire `short-click` immediately without
 *   waiting for a possible second click
 * @csspart button - the inner `<button>`
 * @csspart press-layer - the ripple clip layer
 * @slot - icon content relocated into the inner button (light DOM has no native slot)
 * @fires short-click - single primary click (deferred by `double-click-ms` unless
 *   `disable-double-click` is set); `detail.sourceEvent` carries the original MouseEvent
 * @fires long-press - held past `long-press-ms`, or any modifier-click
 *   (cmd/ctrl/shift/alt); a modifier-click during a pending double-click window
 *   is treated as the second click instead
 * @fires double-click - second primary (or modifier) click inside the window;
 *   suppresses the pending `short-click`
 */
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
  /** The live `animationend` listener for an in-flight delight animation. */
  private animEndListener: ((e: AnimationEvent) => void) | null = null;

  connectedCallback(): void {
    ensurePressButtonStyle(this.ownerDocument);
    if (!this.initialized) {
      this.initialize();
    } else if (this.handle === null) {
      // Re-attached to the DOM after a previous disconnect — the inner
      // button + press layer are still alive (light DOM survives the
      // move) but disconnectedCallback destroyed the gesture handle, so
      // re-arm it here. Without this, a detached-then-reattached host
      // would silently lose click handling.
      this.attachGesture();
    }
    this.syncAttributes();
  }

  disconnectedCallback(): void {
    this.handle?.destroy();
    this.handle = null;
    this.clearPendingShort();
    this.clearRipple();
    // Drop any in-flight delight animation (class + animationend listener) so a
    // detach-then-reattach doesn't surface a button frozen mid-squish/-wobble
    // or leak a listener that can never fire.
    this.clearAnimation();
  }

  attributeChangedCallback(): void {
    if (!this.initialized) return;
    this.syncAttributes();
  }

  /** Whether the inner button is disabled. */
  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', value);
  }

  /** Forwarded to the inner button's `aria-label`. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Forwarded to the inner button's `data-tooltip`. */
  get tooltip(): string | null {
    return this.getAttribute('tooltip');
  }

  set tooltip(value: string | null) {
    if (value == null) this.removeAttribute('tooltip');
    else this.setAttribute('tooltip', value);
  }

  /**
   * Replace the icon HTML inside the inner button while preserving the
   * press layer. Used when a sprinkle's icon resolves asynchronously.
   */
  setIcon(html: string): void {
    if (!this.initialized) this.initialize();
    const btn = this.innerBtn!;
    const layer = this.pressLayer!;
    for (const child of Array.from(btn.childNodes)) {
      if (child !== layer) child.remove();
    }
    const tmp = this.ownerDocument.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) btn.appendChild(tmp.firstChild);
  }

  /** Focus the internal button (so callers don't need to dig in). */
  override focus(options?: FocusOptions): void {
    if (!this.initialized) this.initialize();
    this.innerBtn?.focus(options);
  }

  private initialize(): void {
    this.initialized = true;

    const btn = this.ownerDocument.createElement('button');
    btn.type = 'button';
    btn.className = `${BASE}__btn`;
    btn.setAttribute('part', 'button');

    const layer = this.ownerDocument.createElement('span');
    layer.className = `${BASE}__press-layer`;
    layer.setAttribute('part', 'press-layer');
    btn.appendChild(layer);

    // Move pre-existing host children (the caller's icon) into the
    // inner button so they render on top of the press layer.
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
    // Play the matching delight animation before the event fires so a
    // handler that, say, removes the button still gets one frame of feedback.
    // A single press squishes; a double-press wobbles. Long-press stays calm
    // (the ripple already telegraphs the hold).
    if (type === 'short-click') this.playAnimation(SQUISH_CLASS);
    else if (type === 'double-click') this.playAnimation(WOBBLE_CLASS);

    const detail = source ? { sourceEvent: source } : {};
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail }));
  }

  /**
   * Toggle a one-shot animation class on the inner button. The two classes are
   * mutually exclusive (a rapid double-press shouldn't squish and wobble at
   * once) and each self-removes on `animationend` so the next press re-fires it.
   *
   * Exactly one `animationend` listener is kept alive at a time
   * ({@link clearAnimation} detaches any prior one before each play). That keeps
   * it leak-free under `prefers-reduced-motion: reduce` too: there the CSS sets
   * `animation: none`, so `animationend` never fires — but the next press (or a
   * disconnect) still tears the stale listener down.
   */
  private playAnimation(cls: typeof SQUISH_CLASS | typeof WOBBLE_CLASS): void {
    const btn = this.innerBtn;
    if (!btn) return;
    // Detach any prior in-flight listener + class so this play is the only one.
    this.clearAnimation();
    // Force a reflow so re-adding the same class restarts the animation when a
    // press lands again before the previous one finished.
    void btn.offsetWidth;
    btn.classList.add(cls);
    const onEnd = (e: AnimationEvent): void => {
      if (e.target !== btn) return;
      this.clearAnimation();
    };
    this.animEndListener = onEnd;
    btn.addEventListener('animationend', onEnd);
  }

  /** Remove any in-flight delight animation class + its `animationend` listener. */
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
    // Listen on the host so consumers can dispatchEvent against the
    // custom element directly (matches the long-press lib's contract).
    this.handle = attachLongPressGesture(this, {
      longPressMs: this.longPressMs(),
      onPressStart: (e) => this.paintRipple(e),
      onPressEnd: () => this.clearRipple(),
      onLongPress: () => {
        // A modifier-click that arrives during the double-click window
        // is the second click of a double-click, not a long-press.
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
          // Second plain click inside the window → double-click,
          // pending first short-click is suppressed.
          this.clearPendingShort();
          this.emit('double-click', e);
          return;
        }
        // First click — defer to give a possible second click time
        // to land. CustomEvent fires after `double-click-ms` if no
        // second click arrives.
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
    // Position is computed relative to the press layer (not the host)
    // so callers can give the host padding without offsetting the
    // ripple. The layer fills the inner button via `inset: 0`.
    const rect = layer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Diagonal from the press point to the farthest corner — guarantees
    // the ripple covers the whole button no matter where the click landed.
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
