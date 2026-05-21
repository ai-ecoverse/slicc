/**
 * `<slicc-press-button>` — reusable click + long-press + double-click
 * button. Encapsulates the press-layer + flood-fill ripple visual
 * originally hand-rolled in `rail-zone.ts` so the side rail, the
 * thread-header new-session button, and the chat copy button can all
 * share one component.
 *
 * Internal DOM (light DOM):
 *   <slicc-press-button>
 *     <button class="slicc-press-btn__btn" type="button">
 *       <span class="slicc-press-btn__press-layer"></span>
 *       <!-- caller-supplied icon nodes (slotted at construction) -->
 *     </button>
 *   </slicc-press-button>
 *
 * Attributes (all optional):
 *   - `label`                forwarded to inner button's `aria-label`.
 *   - `tooltip`              forwarded to inner button's `data-tooltip`.
 *   - `tooltip-pos`          forwarded to inner button's `data-tooltip-pos`.
 *   - `long-press-ms`        long-press threshold (default {@link LONG_PRESS_MS}).
 *   - `double-click-ms`      double-click window in ms (default 350).
 *   - `disable-double-click` boolean — fire `short-click` immediately
 *                            without waiting for a possible second click.
 *
 * Events (CustomEvent, bubbles + cancelable):
 *   - `short-click`  — single primary click (deferred by `double-click-ms`
 *                       unless `disable-double-click` is set).
 *   - `long-press`   — held past `long-press-ms`, or any modifier-click
 *                       (cmd/ctrl/shift/alt). A modifier-click during a
 *                       pending double-click window is treated as the
 *                       second click instead.
 *   - `double-click` — second primary (or modifier) click inside the
 *                       double-click window. Suppresses the pending
 *                       `short-click` from the first click.
 *
 * Visual + sizing: the host carries `display: inline-flex` so it can be
 * sized by its parent (rail item, header button, copy button). The
 * inner button fills the host (`width/height: 100%`) so the ripple's
 * bounding rect matches what the user sees as "the button".
 */

import { LONG_PRESS_MS, attachLongPressGesture, type LongPressHandle } from './long-press.js';

/** Default delay before committing a single click as a `short-click`. */
export const DEFAULT_DOUBLE_CLICK_MS = 350;

/** BEM-ish base class for the component's own DOM hooks. */
const BASE = 'slicc-press-btn';

/** Public typing for the host element. */
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

  connectedCallback(): void {
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
  }

  attributeChangedCallback(): void {
    if (!this.initialized) return;
    this.syncAttributes();
  }

  /**
   * Replace the icon HTML inside the inner button while preserving the
   * press layer. Used by `RailZone.setItemIcon` when a sprinkle's icon
   * resolves asynchronously.
   */
  setIcon(html: string): void {
    if (!this.initialized) this.initialize();
    const btn = this.innerBtn!;
    const layer = this.pressLayer!;
    for (const child of Array.from(btn.childNodes)) {
      if (child !== layer) child.remove();
    }
    const tmp = document.createElement('div');
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

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${BASE}__btn`;

    const layer = document.createElement('span');
    layer.className = `${BASE}__press-layer`;
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
    const detail = source ? { sourceEvent: source } : {};
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, cancelable: true, detail }));
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
    const span = document.createElement('span');
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

if (typeof customElements !== 'undefined' && !customElements.get('slicc-press-button')) {
  customElements.define('slicc-press-button', SliccPressButton);
}
