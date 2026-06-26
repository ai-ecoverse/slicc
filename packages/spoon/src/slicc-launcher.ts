// Sliccy mono SVG logos imported as raw strings (Vite `?raw` feature, declared
// in `src/css.d.ts`). Each follower-status state ships a dark + light variant:
// the dark variant has a dark fill + white outlines so it reads on light
// backgrounds; the light variant inverts that for dark backgrounds. The
// `follower-status` host attribute gates which state-wrapper is visible, and
// a color-scheme media query gates which variant inside it is visible (matches
// the original electron-overlay behavior). Parsed via DOMParser at runtime so
// the markup can be appended without `.innerHTML` (forbidden by `lint:no-innerhtml`).

import sliccyDarkErrorSvg from '../../../assets/logos/sliccy-error-mono-dark-0scoops.svg?raw';
import sliccyLightErrorSvg from '../../../assets/logos/sliccy-error-mono-light-0scoops.svg?raw';
import sliccyDarkDisconnectedSvg from '../../../assets/logos/sliccy-mono-dark-0scoops.svg?raw';
import sliccyDarkConnectedSvg from '../../../assets/logos/sliccy-mono-dark-1scoops.svg?raw';
import sliccyLightDisconnectedSvg from '../../../assets/logos/sliccy-mono-light-0scoops.svg?raw';
import sliccyLightConnectedSvg from '../../../assets/logos/sliccy-mono-light-1scoops.svg?raw';
import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import {
  DEFAULT_LAUNCHER_CORNER,
  LAUNCHER_FOLLOWER_STATUS_ATTR,
  LAUNCHER_OFFSET_PX,
  LAUNCHER_STORAGE_KEY,
  type LauncherCorner,
  type LauncherFollowerStatus,
  normalizeLauncherCorner,
  normalizeLauncherFollowerStatus,
  resolveLauncherCorner,
  shouldSnapLauncher,
} from './launcher-state.js';

export type { LauncherCorner, LauncherFollowerStatus } from './launcher-state.js';

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
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
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

/* === Sliccy mono logo — three follower-status state-wrappers render
   side-by-side; the host follower-status attribute selects which wrapper is
   visible, and inside each, a color-scheme media query gates the dark vs
   light variant. Absent/invalid attribute falls back to "disconnected" so the
   launcher never starts on the misleading "connected" icon. Matches the
   original electron-overlay logo wrappers. === */
/* The button is the ONLY interactive surface: every child (the logo wrapper,
   the SVG glyph inside it, and the tab label) is pointer-transparent so the
   whole pill is one click target and the grab cursor never flips to the page
   cursor when hovering the icon. pointer-events inherits, so setting it on
   .logo covers .logo-state / .logo-icon / svg too. */
.logo, .tab-label { pointer-events: none; }
.logo-icon { width: 32px; height: 32px; display: block; }
.logo-icon svg { width: 100%; height: 100%; display: block; }
.logo-state { display: none; }
:host(:not([${LAUNCHER_FOLLOWER_STATUS_ATTR}])) .logo-state-disconnected,
:host([${LAUNCHER_FOLLOWER_STATUS_ATTR}="disconnected"]) .logo-state-disconnected,
:host([${LAUNCHER_FOLLOWER_STATUS_ATTR}="connected"]) .logo-state-connected,
:host([${LAUNCHER_FOLLOWER_STATUS_ATTR}="error"]) .logo-state-error { display: contents; }
.logo-for-dark { display: block; }
.logo-for-light { display: none; }
@media (prefers-color-scheme: light) {
  .logo-for-dark { display: none; }
  .logo-for-light { display: block; }
}

/* === Tab mode (edge midpoints) — width/height auto, label visible, rounded
   only on the two edges NOT touching the viewport edge. Matches
   electron-overlay.ts lines 230-263. === */
.tab-label {
  display: none;
  font-size: 12px; font-weight: 700;
  letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
}
:host([corner="top"]) .launcher,
:host([corner="bottom"]) .launcher,
:host([corner="left"]) .launcher,
:host([corner="right"]) .launcher {
  width: auto; height: auto;
  border-radius: 0;
  padding: 6px 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,.2);
}
:host([corner="top"]) .launcher,
:host([corner="bottom"]) .launcher { flex-direction: row; }
:host([corner="left"]) .launcher,
:host([corner="right"]) .launcher { flex-direction: column; padding: 10px 6px; }
:host([corner="left"]) .tab-label,
:host([corner="right"]) .tab-label { writing-mode: vertical-lr; }
:host([corner="right"]) .tab-label { rotate: 180deg; }
:host([corner="top"]) .launcher    { border-radius: 0 0 10px 10px; }
:host([corner="bottom"]) .launcher { border-radius: 10px 10px 0 0; }
:host([corner="left"]) .launcher   { border-radius: 0 10px 10px 0; }
:host([corner="right"]) .launcher  { border-radius: 10px 0 0 10px; }
:host([corner="top"]) .tab-label,
:host([corner="bottom"]) .tab-label,
:host([corner="left"]) .tab-label,
:host([corner="right"]) .tab-label { display: block; }
:host([corner="top"]) .logo-icon,
:host([corner="bottom"]) .logo-icon,
:host([corner="left"]) .logo-icon,
:host([corner="right"]) .logo-icon { width: 22px; height: 22px; }

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

/* === Drag suppression — while the launcher is being dragged, fully hide the
   sidebar + backdrop so the iframe never repaints under the moving cursor and
   a mid-drag corner change can't slide the panel across the viewport. The
   iframe is only visible when [open] AND not [dragging]. === */
:host([dragging]) .sidebar,
:host([dragging]) .backdrop {
  transition: none;
  visibility: hidden;
  pointer-events: none;
}

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

/** Parse a `?raw` SVG string into an importable `<svg>` element without
 *  touching innerHTML (forbidden by `lint:no-innerhtml`). The leading XML
 *  declaration is stripped because `DOMParser` accepts it inconsistently. */
function parseSvg(raw: string): SVGElement {
  const stripped = raw.replace(/<\?xml[^?]*\?>\s*/i, '');
  const parsed = new DOMParser().parseFromString(stripped, 'image/svg+xml');
  return document.importNode(parsed.documentElement, true) as unknown as SVGElement;
}

/** Per-state SVG pair (dark + light variant) for one follower-status. */
interface StateIcons {
  state: LauncherFollowerStatus;
  darkSvg: string;
  lightSvg: string;
}

const STATE_ICONS: readonly StateIcons[] = [
  {
    state: 'disconnected',
    darkSvg: sliccyDarkDisconnectedSvg,
    lightSvg: sliccyLightDisconnectedSvg,
  },
  { state: 'connected', darkSvg: sliccyDarkConnectedSvg, lightSvg: sliccyLightConnectedSvg },
  { state: 'error', darkSvg: sliccyDarkErrorSvg, lightSvg: sliccyLightErrorSvg },
];

/** Build the Sliccy logo group — three state wrappers (disconnected / connected
 *  / error) rendered side-by-side, each carrying both dark + light variants.
 *  CSS gates which wrapper is visible from the host's `follower-status`
 *  attribute and which variant inside it from `prefers-color-scheme`. */
function buildLogo(): HTMLElement {
  const logo = h('span', { class: 'logo', part: 'logo' });
  for (const { state, darkSvg, lightSvg } of STATE_ICONS) {
    const forDark = h('div', { class: 'logo-icon logo-for-dark' });
    forDark.appendChild(parseSvg(darkSvg));
    const forLight = h('div', { class: 'logo-icon logo-for-light' });
    forLight.appendChild(parseSvg(lightSvg));
    const wrapper = h(
      'span',
      { class: `logo-state logo-state-${state}`, 'aria-hidden': 'true' },
      forDark,
      forLight
    );
    logo.appendChild(wrapper);
  }
  return logo;
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
 * @attr follower-status - one of `disconnected | connected | error`; absent or invalid → `disconnected`
 * @csspart launcher - the floating button
 * @csspart sidebar - the sidebar shell
 * @csspart backdrop - the dimmed backdrop behind the sidebar
 * @fires slicc-launcher-toggle - `{ open }` whenever the open state flips
 * @fires slicc-launcher-focus - on a double-click; no detail
 * @fires slicc-launcher-move - `{ corner }` after a drag snaps to a new corner
 */
export class SliccLauncher extends HTMLElement {
  static readonly observedAttributes = ['open', 'corner', 'app-url', LAUNCHER_FOLLOWER_STATUS_ATTR];

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
    if (name === LAUNCHER_FOLLOWER_STATUS_ATTR) {
      // Coerce invalid attribute values back to `disconnected` so CSS gating
      // (which can't express "anything not in {connected, error}") always
      // resolves to a visible wrapper.
      const raw = this.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR);
      if (raw !== null) {
        const next = normalizeLauncherFollowerStatus(raw);
        if (next !== raw) {
          this.#syncingAttributes = true;
          this.setAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR, next);
          this.#syncingAttributes = false;
        }
      }
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

  /** Follower-link status — drives which Sliccy icon variant is visible.
   *  Reading the property always returns a valid value (absent/invalid
   *  attribute → `disconnected`); setting it reflects to the attribute. */
  get followerStatus(): LauncherFollowerStatus {
    return normalizeLauncherFollowerStatus(this.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR));
  }
  set followerStatus(value: LauncherFollowerStatus | null | undefined) {
    if (value == null) {
      this.removeAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR);
      return;
    }
    const next = normalizeLauncherFollowerStatus(value);
    if (this.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR) === next) return;
    this.setAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR, next);
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
      buildLogo(),
      h('span', { class: 'tab-label', part: 'tab-label' }, 'SLICC')
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
