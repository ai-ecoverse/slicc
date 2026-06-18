import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import {
  DEFAULT_LAUNCHER_CORNER,
  LAUNCHER_OFFSET_PX,
  LAUNCHER_STORAGE_KEY,
  type LauncherCorner,
  normalizeLauncherCorner,
  resolveLauncherCorner,
  shouldSnapLauncher,
} from './launcher-state.js';

export type { LauncherCorner } from './launcher-state.js';

const STYLE = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  display: block;
  pointer-events: none;
  z-index: 2147483647;
  contain: layout style paint;
  font-family: var(--ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
}
*, *::before, *::after { box-sizing: border-box; }

/* === Floating button — positioned by the corner attribute === */
.launcher {
  position: absolute;
  width: 44px; height: 44px;
  border: none; border-radius: 9999px;
  background: var(--canvas, #fff); color: var(--ink, #131313);
  box-shadow: 0 2px 8px rgba(0,0,0,.2), 0 0 0 1px rgba(0,0,0,.08);
  cursor: grab;
  display: inline-flex; align-items: center; justify-content: center;
  pointer-events: auto;
  touch-action: none; user-select: none; -webkit-user-select: none;
  padding: 0; overflow: hidden;
  transition: top 130ms ease, right 130ms ease, bottom 130ms ease, left 130ms ease,
              box-shadow 130ms ease, transform 130ms ease;
}
:host([corner="top-left"])     .launcher { top: ${LAUNCHER_OFFSET_PX}px; left: ${LAUNCHER_OFFSET_PX}px; }
:host(:not([corner])) .launcher,
:host([corner="top-right"])    .launcher { top: ${LAUNCHER_OFFSET_PX}px; right: ${LAUNCHER_OFFSET_PX}px; }
:host([corner="bottom-left"])  .launcher { bottom: ${LAUNCHER_OFFSET_PX}px; left: ${LAUNCHER_OFFSET_PX}px; }
:host([corner="bottom-right"]) .launcher { bottom: ${LAUNCHER_OFFSET_PX}px; right: ${LAUNCHER_OFFSET_PX}px; }
:host([corner="top"])    .launcher { top: 0; left: 50%; transform: translateX(-50%); }
:host([corner="bottom"]) .launcher { bottom: 0; left: 50%; transform: translateX(-50%); }
:host([corner="left"])   .launcher { left: 0; top: 50%; transform: translateY(-50%); }
:host([corner="right"])  .launcher { right: 0; top: 50%; transform: translateY(-50%); }
:host([dragging]) .launcher { transition: none; cursor: grabbing; }
.launcher:hover { box-shadow: 0 4px 16px rgba(0,0,0,.3), 0 0 0 1px rgba(0,0,0,.12); }
.launcher:active { transform: scale(.96); }
:host([open]) .launcher { box-shadow: 0 4px 16px rgba(0,0,0,.3), 0 0 0 2px var(--ctx, #3562ff); }
.launcher .glyph { width: 22px; height: 22px; display: block; pointer-events: none; }

/* === Sidebar — full-screen overlay with iframe === */
.backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,.18);
  opacity: 0; pointer-events: none;
  transition: opacity 130ms ease;
}
:host([open]) .backdrop { opacity: 1; pointer-events: auto; }
.sidebar {
  position: absolute; top: 12px; right: 12px; bottom: 12px;
  width: min(440px, calc(100vw - 24px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--canvas, #fff); color: var(--ink, #131313);
  border: 1px solid var(--line, rgba(0,0,0,.12));
  border-radius: 16px;
  box-shadow: 0 18px 50px -12px rgba(10,10,10,.35), 0 4px 12px -4px rgba(10,10,10,.18);
  transform: translateX(calc(100% + 28px));
  transition: transform 180ms cubic-bezier(.4,0,.2,1);
  pointer-events: none;
}
:host([open]) .sidebar { transform: translateX(0); pointer-events: auto; }
:host([corner="left"]) .sidebar,
:host([corner="top-left"]) .sidebar,
:host([corner="bottom-left"]) .sidebar {
  right: auto; left: 12px;
  transform: translateX(calc(-100% - 28px));
}
:host([open][corner="left"]) .sidebar,
:host([open][corner="top-left"]) .sidebar,
:host([open][corner="bottom-left"]) .sidebar { transform: translateX(0); }
:host([corner="top"]) .sidebar    { top: 12px; bottom: auto; height: calc(100vh - 24px); transform: translateY(calc(-100% - 28px)); }
:host([corner="bottom"]) .sidebar { top: auto; bottom: 12px; height: calc(100vh - 24px); transform: translateY(calc(100% + 28px)); }
:host([open][corner="top"]) .sidebar,
:host([open][corner="bottom"]) .sidebar { transform: translateY(0); }
.viewport { position: relative; flex: 1; min-height: 0; background: var(--bg, #f4f4f4); }
.viewport iframe { border: 0; width: 100%; height: 100%; display: block; }
.empty {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center;
  color: var(--txt-3, #717171); font-size: 13px; line-height: 1.5;
}
.empty[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) {
  .launcher, .sidebar, .backdrop { transition: none; }
}
`;
const SHEET = sheet(STYLE);

const SVG_NS = 'http://www.w3.org/2000/svg';
function glyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'glyph');
  for (const d of ['M4 12h16', 'M4 6h16', 'M4 18h16']) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

interface PointerState {
  pointerId: number;
  startX: number;
  startY: number;
  startLeft: number;
  startTop: number;
  width: number;
  height: number;
  lastX: number;
  lastY: number;
  lastTimestamp: number;
  velocityX: number;
  velocityY: number;
  dragging: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** `slicc-launcher-toggle` event detail (open ↔ closed). */
export interface LauncherToggleDetail {
  open: boolean;
}

/** `slicc-launcher-move` event detail — the new corner after a drag-snap. */
export interface LauncherMoveDetail {
  corner: LauncherCorner;
}

function readPersistedCorner(view: Window | null | undefined): LauncherCorner {
  try {
    return normalizeLauncherCorner(view?.localStorage.getItem(LAUNCHER_STORAGE_KEY));
  } catch {
    return DEFAULT_LAUNCHER_CORNER;
  }
}

function persistCorner(view: Window | null | undefined, corner: LauncherCorner): void {
  try {
    view?.localStorage.setItem(LAUNCHER_STORAGE_KEY, corner);
  } catch {
    /* host page may not expose localStorage */
  }
}

/**
 * `<slicc-launcher>` — the floating launcher + sidebar shell extracted from the
 * Electron overlay. A draggable button (`44px` pill at one of 8 snap targets —
 * the four corners plus the four edge midpoints) that toggles a right-edge
 * sidebar containing an `<iframe>` pointed at the host SLICC app.
 *
 * **Single-click** the button toggles open/closed (fires `slicc-launcher-toggle`).
 * **Double-click** the button fires `slicc-launcher-focus` — leaders use this to
 * bring the SLICC tab to focus without touching the open state. **Drag** the
 * button to snap it to a different corner / edge midpoint; the choice persists
 * in `localStorage` so the next mount lands where the user left it.
 *
 * @attr app-url - the URL loaded in the sidebar iframe; empty hides the iframe
 * @attr open - reflected; whether the sidebar is shown
 * @attr corner - one of `top-left | top-right | bottom-left | bottom-right | top | right | bottom | left`
 * @csspart launcher - the floating button
 * @csspart sidebar - the sidebar shell
 * @csspart backdrop - the dimmed backdrop behind the sidebar
 * @fires slicc-launcher-toggle - `{ open }` whenever the open state flips
 * @fires slicc-launcher-focus - on a double-click; no detail
 * @fires slicc-launcher-move - `{ corner }` after a drag snaps to a new corner
 */
export class SliccLauncher extends HTMLElement {
  static readonly observedAttributes = ['open', 'corner', 'app-url'];

  readonly #root: ShadowRoot;
  #button!: HTMLButtonElement;
  #backdrop!: HTMLElement;
  #sidebar!: HTMLElement;
  #iframe!: HTMLIFrameElement;
  #empty!: HTMLElement;
  #currentAppUrl = '';
  #pointerState: PointerState | null = null;
  #suppressClick = false;
  #syncingAttributes = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
    this.#build();
  }

  connectedCallback(): void {
    if (!this.hasAttribute('corner')) {
      const persisted = readPersistedCorner(this.ownerDocument.defaultView);
      this.#syncingAttributes = true;
      this.setAttribute('corner', persisted);
      this.#syncingAttributes = false;
    }
    this.#syncIframe();
  }

  attributeChangedCallback(name: string): void {
    if (this.#syncingAttributes) return;
    if (name === 'app-url') this.#syncIframe();
    if (name === 'corner') {
      persistCorner(this.ownerDocument.defaultView, this.corner);
    }
  }

  /** Whether the sidebar is open. */
  get open(): boolean {
    return this.hasAttribute('open');
  }
  set open(value: boolean) {
    if (this.open === value) return;
    this.toggleAttribute('open', value);
    this.#emitToggle();
  }

  /** Snap corner — one of the 8 launcher positions. */
  get corner(): LauncherCorner {
    return normalizeLauncherCorner(this.getAttribute('corner'));
  }
  set corner(value: LauncherCorner) {
    const next = normalizeLauncherCorner(value);
    if (this.corner === next && this.hasAttribute('corner')) return;
    this.setAttribute('corner', next);
  }

  /** URL loaded in the sidebar iframe (empty hides the iframe). */
  get appUrl(): string {
    return this.getAttribute('app-url')?.trim() ?? '';
  }
  set appUrl(value: string | null) {
    const next = (value ?? '').trim();
    if (next) this.setAttribute('app-url', next);
    else this.removeAttribute('app-url');
  }

  /** Show the sidebar. */
  show(): void {
    this.open = true;
  }
  /** Hide the sidebar. */
  hide(): void {
    this.open = false;
  }
  /** Flip the open state. */
  toggle(): void {
    this.open = !this.open;
  }

  #build(): void {
    this.#button = h(
      'button',
      {
        class: 'launcher',
        part: 'launcher',
        type: 'button',
        'aria-label': 'Toggle SLICC',
      },
      glyph()
    ) as HTMLButtonElement;
    this.#button.addEventListener('click', (e) => {
      if (this.#suppressClick) {
        this.#suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      this.toggle();
    });
    this.#button.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.dispatchEvent(
        new CustomEvent('slicc-launcher-focus', { bubbles: true, composed: true })
      );
    });
    this.#button.addEventListener('pointerdown', this.#onPointerDown);
    this.#button.addEventListener('pointermove', this.#onPointerMove);
    this.#button.addEventListener('pointerup', this.#onPointerUp);
    this.#button.addEventListener('pointercancel', this.#onPointerCancel);

    this.#backdrop = h('div', { class: 'backdrop', part: 'backdrop' });
    this.#backdrop.addEventListener('click', () => this.hide());

    this.#iframe = h('iframe', { title: 'SLICC overlay' }) as HTMLIFrameElement;
    this.#empty = h('div', { class: 'empty' }, 'Set the app-url attribute to load SLICC.');
    const viewport = h('div', { class: 'viewport' }, this.#iframe, this.#empty);
    this.#sidebar = h(
      'aside',
      {
        class: 'sidebar',
        part: 'sidebar',
        'aria-label': 'SLICC launcher sidebar',
      },
      viewport
    );

    this.#root.replaceChildren(this.#backdrop, this.#sidebar, this.#button);
  }

  #emitToggle(): void {
    this.dispatchEvent(
      new CustomEvent<LauncherToggleDetail>('slicc-launcher-toggle', {
        detail: { open: this.open },
        bubbles: true,
        composed: true,
      })
    );
  }

  #syncIframe(): void {
    const url = this.appUrl;
    this.#empty.toggleAttribute('hidden', Boolean(url));
    if (!url) {
      if (this.#currentAppUrl) {
        this.#currentAppUrl = '';
        this.#iframe.removeAttribute('src');
      }
      return;
    }
    if (url === this.#currentAppUrl) return;
    this.#currentAppUrl = url;
    this.#iframe.src = url;
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = this.#button.getBoundingClientRect();
    this.#pointerState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
      lastX: event.clientX,
      lastY: event.clientY,
      lastTimestamp: event.timeStamp,
      velocityX: 0,
      velocityY: 0,
      dragging: false,
    };
    this.#suppressClick = false;
    this.#button.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  #onPointerMove = (event: PointerEvent): void => {
    const state = this.#pointerState;
    if (!state || event.pointerId !== state.pointerId) return;
    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    const distance = Math.hypot(deltaX, deltaY);
    if (!state.dragging && shouldSnapLauncher(distance, 0)) {
      state.dragging = true;
      this.setAttribute('dragging', '');
    }
    const dt = Math.max(event.timeStamp - state.lastTimestamp, 1);
    const nextVX = (event.clientX - state.lastX) / dt;
    const nextVY = (event.clientY - state.lastY) / dt;
    state.velocityX = state.velocityX === 0 ? nextVX : state.velocityX * 0.35 + nextVX * 0.65;
    state.velocityY = state.velocityY === 0 ? nextVY : state.velocityY * 0.35 + nextVY * 0.65;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastTimestamp = event.timeStamp;
    if (!state.dragging) return;
    const maxLeft = Math.max(
      LAUNCHER_OFFSET_PX,
      window.innerWidth - state.width - LAUNCHER_OFFSET_PX
    );
    const maxTop = Math.max(
      LAUNCHER_OFFSET_PX,
      window.innerHeight - state.height - LAUNCHER_OFFSET_PX
    );
    const left = clamp(state.startLeft + deltaX, LAUNCHER_OFFSET_PX, maxLeft);
    const top = clamp(state.startTop + deltaY, LAUNCHER_OFFSET_PX, maxTop);
    this.#button.style.left = `${left}px`;
    this.#button.style.top = `${top}px`;
    this.#button.style.right = 'auto';
    this.#button.style.bottom = 'auto';
    event.preventDefault();
  };

  #onPointerUp = (event: PointerEvent): void => {
    this.#finishPointer(event, true);
  };

  #onPointerCancel = (event: PointerEvent): void => {
    this.#finishPointer(event, false);
  };

  #finishPointer(event: PointerEvent, allowSnap: boolean): void {
    const state = this.#pointerState;
    if (!state || event.pointerId !== state.pointerId) return;
    const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    const velocity = Math.hypot(state.velocityX, state.velocityY);
    const snap = allowSnap && (state.dragging || shouldSnapLauncher(distance, velocity));
    if (snap) {
      const corner = resolveLauncherCorner({
        clientX: event.clientX,
        clientY: event.clientY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        velocityXPxPerMs: state.velocityX,
        velocityYPxPerMs: state.velocityY,
      });
      this.corner = corner;
      this.dispatchEvent(
        new CustomEvent<LauncherMoveDetail>('slicc-launcher-move', {
          detail: { corner },
          bubbles: true,
          composed: true,
        })
      );
      this.#suppressClick = true;
      event.preventDefault();
    }
    if (this.#button.hasPointerCapture(event.pointerId)) {
      this.#button.releasePointerCapture(event.pointerId);
    }
    this.#pointerState = null;
    this.removeAttribute('dragging');
    this.#button.style.left = '';
    this.#button.style.top = '';
    this.#button.style.right = '';
    this.#button.style.bottom = '';
  }
}

define('slicc-launcher', SliccLauncher);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-launcher': SliccLauncher;
  }
  interface HTMLElementEventMap {
    'slicc-launcher-toggle': CustomEvent<LauncherToggleDetail>;
    'slicc-launcher-focus': CustomEvent<void>;
    'slicc-launcher-move': CustomEvent<LauncherMoveDetail>;
  }
}
