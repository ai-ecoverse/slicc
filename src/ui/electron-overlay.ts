import {
  createElectronOverlayShellState,
  normalizeElectronOverlayLauncherCorner,
  resolveElectronOverlayLauncherCorner,
  setElectronOverlayCorner,
  setElectronOverlayOpen,
  setElectronOverlayTab,
  shouldSnapElectronOverlayLauncher,
  toggleElectronOverlay,
  type ElectronOverlayLauncherCorner,
  type ElectronOverlayShellState,
} from './overlay-shell-state.js';
import { ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE } from './runtime-mode.js';
import { EXTENSION_TAB_SPECS, normalizeExtensionTabId, type ExtensionTabId } from './tabbed-ui.js';

export const ELECTRON_OVERLAY_HOST_ID = 'slicc-electron-overlay-root';
export const ELECTRON_OVERLAY_TAG_NAME = 'slicc-electron-overlay';

const ELECTRON_OVERLAY_LAUNCHER_TAG_NAME = 'slicc-electron-launcher';
const ELECTRON_OVERLAY_SIDEBAR_TAG_NAME = 'slicc-electron-sidebar';
const DEFAULT_APP_URL = '';
const ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX = 18;
const ELECTRON_OVERLAY_LAUNCHER_SESSION_STORAGE_KEY = 'slicc-electron-overlay-launcher-corner';

interface LauncherPointerState {
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

/**
 * Create a style element with CSS text (works with Trusted Types).
 */
function createStyle(doc: Document, css: string): HTMLStyleElement {
  const style = doc.createElement('style');
  style.textContent = css;
  return style;
}

/**
 * Create an SVG element with the cone icon.
 */
function createConeIconSvg(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  
  const circles = [
    { cx: '9', cy: '7.2', r: '4.1' },
    { cx: '15.2', cy: '8.1', r: '4' },
    { cx: '12', cy: '14.6', r: '6.6' },
  ];
  
  for (const { cx, cy, r } of circles) {
    const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r);
    svg.appendChild(circle);
  }
  
  return svg;
}

const BASE_TOKENS = `
  :host {
    color-scheme: dark light;
    --s2-gray-25: #1a1a1a;
    --s2-gray-50: #1e1e1e;
    --s2-gray-75: #252525;
    --s2-gray-100: #2c2c2c;
    --s2-gray-200: #3a3a3a;
    --s2-gray-300: #4a4a4a;
    --s2-gray-600: #8a8a8a;
    --s2-gray-700: #a1a1a1;
    --s2-gray-900: #e8e8e8;
    --s2-bg-base: var(--s2-gray-25);
    --s2-bg-layer-1: var(--s2-gray-50);
    --s2-bg-layer-2: var(--s2-gray-75);
    --s2-bg-elevated: var(--s2-gray-100);
    --s2-bg-sunken: #141414;
    --s2-content-default: var(--s2-gray-900);
    --s2-content-secondary: var(--s2-gray-700);
    --s2-border-default: var(--s2-gray-300);
    --s2-border-subtle: var(--s2-gray-200);
    --s2-accent: #3562ff;
    --s2-accent-hover: #4a75ff;
    --s2-font-family: 'Adobe Clean', 'Source Sans Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --s2-radius-default: 8px;
    --s2-radius-xl: 16px;
    --s2-radius-pill: 9999px;
    --s2-shadow-elevated: 0 10px 32px rgba(0, 0, 0, 0.35), 0 2px 10px rgba(0, 0, 0, 0.2);
    --s2-transition-default: 130ms ease;
    --slicc-cone: #ef7000;
  }

  @media (prefers-color-scheme: light) {
    :host {
      --s2-gray-25: #ffffff;
      --s2-gray-50: #f8f8f8;
      --s2-gray-75: #f0f0f0;
      --s2-gray-100: #e8e8e8;
      --s2-gray-200: #d6d6d6;
      --s2-gray-300: #c4c4c4;
      --s2-gray-600: #6e6e6e;
      --s2-gray-700: #5a5a5a;
      --s2-gray-900: #1a1a1a;
      --s2-bg-sunken: #f0f0f0;
      --s2-accent: #2b54db;
      --s2-accent-hover: #1e44c4;
      --s2-shadow-elevated: 0 10px 32px rgba(0, 0, 0, 0.14), 0 2px 10px rgba(0, 0, 0, 0.08);
    }
  }
`;

function withTabQuery(appUrl: string, activeTab: ExtensionTabId): string {
  try {
    const url = new URL(appUrl, window.location.href);
    url.searchParams.set('tab', activeTab);
    return url.toString();
  } catch {
    return appUrl;
  }
}

class SliccElectronLauncherElement extends HTMLElement {
  static observedAttributes = ['open', 'corner'];

  private button: HTMLButtonElement | null = null;
  private pointerState: LauncherPointerState | null = null;
  private suppressClick = false;

  connectedCallback(): void {
    if (!this.shadowRoot) this.render();
    this.sync();
  }

  attributeChangedCallback(): void {
    this.sync();
  }

  private render(): void {
    const root = this.attachShadow({ mode: 'open' });
    const doc = this.ownerDocument;
    const offset = ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX;

    // Create style
    root.appendChild(createStyle(doc, `
      ${BASE_TOKENS}
      :host {
        all: initial;
        position: fixed;
        top: ${offset}px;
        right: ${offset}px;
        z-index: 1;
        pointer-events: auto;
        display: block;
        font-family: var(--s2-font-family);
        transition: top var(--s2-transition-default), right var(--s2-transition-default), bottom var(--s2-transition-default), left var(--s2-transition-default);
      }
      :host([corner="top-left"]) { top: ${offset}px; right: auto; bottom: auto; left: ${offset}px; }
      :host([corner="top-right"]) { top: ${offset}px; right: ${offset}px; bottom: auto; left: auto; }
      :host([corner="bottom-left"]) { top: auto; right: auto; bottom: ${offset}px; left: ${offset}px; }
      :host([corner="bottom-right"]) { top: auto; right: ${offset}px; bottom: ${offset}px; left: auto; }
      :host([dragging]) { transition: none; }
      *, *::before, *::after { box-sizing: border-box; }
      button {
        width: 44px; height: 44px; position: relative;
        border: 1px solid rgba(255, 255, 255, 0.62);
        border-radius: var(--s2-radius-pill);
        background: radial-gradient(circle at 30% 28%, rgba(255, 255, 255, 0.34), transparent 34%),
          linear-gradient(160deg, #ffb15c 0%, color-mix(in srgb, var(--slicc-cone) 92%, #ffb15c) 34%, #a34b00 72%, #38220f 100%);
        color: #fff;
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18) inset, 0 0 0 4px rgba(0, 0, 0, 0.28), 0 12px 30px rgba(0, 0, 0, 0.4), 0 2px 10px rgba(0, 0, 0, 0.24);
        cursor: grab;
        display: inline-flex; align-items: center; justify-content: center;
        transition: transform var(--s2-transition-default), background var(--s2-transition-default), border-color var(--s2-transition-default), box-shadow var(--s2-transition-default);
        backdrop-filter: blur(12px) saturate(1.05);
        touch-action: none; user-select: none; -webkit-user-select: none;
      }
      button::before {
        content: ''; position: absolute; inset: -5px; border-radius: inherit;
        border: 1px solid rgba(255, 255, 255, 0.32); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.18); pointer-events: none;
      }
      :host([dragging]) button { cursor: grabbing; }
      button:hover {
        transform: translateY(-1px); border-color: rgba(255, 255, 255, 0.78);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.24) inset, 0 0 0 4px rgba(0, 0, 0, 0.34), 0 16px 34px rgba(0, 0, 0, 0.44), 0 0 18px color-mix(in srgb, var(--slicc-cone) 40%, transparent);
      }
      button:active { transform: scale(0.96); }
      button[aria-pressed="true"] {
        border-color: rgba(255, 255, 255, 0.84);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.24) inset, 0 0 0 4px rgba(0, 0, 0, 0.36), 0 16px 38px rgba(0, 0, 0, 0.46), 0 0 22px color-mix(in srgb, var(--slicc-cone) 52%, transparent);
      }
      svg { width: 20px; height: 20px; fill: currentColor; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55)); }
    `));

    // Create button with SVG icon
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Toggle SLICC overlay');
    button.appendChild(createConeIconSvg(doc));
    root.appendChild(button);

    this.button = button;
    this.button?.addEventListener('click', (event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      this.dispatchEvent(
        new CustomEvent('slicc-overlay-toggle', { bubbles: true, composed: true })
      );
    });
    this.button?.addEventListener('pointerdown', this.onPointerDown);
    this.button?.addEventListener('pointermove', this.onPointerMove);
    this.button?.addEventListener('pointerup', this.onPointerUp);
    this.button?.addEventListener('pointercancel', this.onPointerCancel);
  }

  private sync(): void {
    this.button?.setAttribute('aria-pressed', String(this.hasAttribute('open')));
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || !this.button) return;

    const rect = this.getBoundingClientRect();
    this.pointerState = {
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
    this.suppressClick = false;
    this.button.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const state = this.pointerState;
    if (!state || event.pointerId !== state.pointerId) return;

    const deltaX = event.clientX - state.startX;
    const deltaY = event.clientY - state.startY;
    const distance = Math.hypot(deltaX, deltaY);
    if (!state.dragging && shouldSnapElectronOverlayLauncher(distance, 0)) {
      state.dragging = true;
      this.setAttribute('dragging', '');
    }

    const dt = Math.max(event.timeStamp - state.lastTimestamp, 1);
    const nextVelocityX = (event.clientX - state.lastX) / dt;
    const nextVelocityY = (event.clientY - state.lastY) / dt;
    state.velocityX =
      state.velocityX === 0 ? nextVelocityX : state.velocityX * 0.35 + nextVelocityX * 0.65;
    state.velocityY =
      state.velocityY === 0 ? nextVelocityY : state.velocityY * 0.35 + nextVelocityY * 0.65;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastTimestamp = event.timeStamp;

    if (!state.dragging) return;

    const maxLeft = Math.max(
      ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX,
      window.innerWidth - state.width - ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX
    );
    const maxTop = Math.max(
      ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX,
      window.innerHeight - state.height - ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX
    );
    const left = clamp(state.startLeft + deltaX, ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX, maxLeft);
    const top = clamp(state.startTop + deltaY, ELECTRON_OVERLAY_LAUNCHER_OFFSET_PX, maxTop);
    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
    this.style.right = 'auto';
    this.style.bottom = 'auto';
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.finishPointerInteraction(event);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.finishPointerInteraction(event, false);
  };

  private finishPointerInteraction(event: PointerEvent, allowSnap = true): void {
    const state = this.pointerState;
    if (!state || event.pointerId !== state.pointerId || !this.button) return;

    const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    const velocity = Math.hypot(state.velocityX, state.velocityY);
    const shouldSnap =
      allowSnap && (state.dragging || shouldSnapElectronOverlayLauncher(distance, velocity));

    if (shouldSnap) {
      const corner = resolveElectronOverlayLauncherCorner({
        clientX: event.clientX,
        clientY: event.clientY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        velocityXPxPerMs: state.velocityX,
        velocityYPxPerMs: state.velocityY,
      });
      this.dispatchEvent(
        new CustomEvent<{ corner: ElectronOverlayLauncherCorner }>('slicc-overlay-move', {
          bubbles: true,
          composed: true,
          detail: { corner },
        })
      );
      this.suppressClick = true;
      event.preventDefault();
    }

    if (this.button.hasPointerCapture(event.pointerId)) {
      this.button.releasePointerCapture(event.pointerId);
    }
    this.pointerState = null;
    this.removeAttribute('dragging');
    this.resetDragStyles();
  }

  private resetDragStyles(): void {
    this.style.left = '';
    this.style.top = '';
    this.style.right = '';
    this.style.bottom = '';
  }
}

class SliccElectronSidebarElement extends HTMLElement {
  static observedAttributes = ['open', 'active-tab', 'app-url'];

  private tabButtons = new Map<ExtensionTabId, HTMLButtonElement>();
  private iframe: HTMLIFrameElement | null = null;
  private emptyState: HTMLElement | null = null;
  private currentAppUrl = DEFAULT_APP_URL;
  private frameLoaded = false;
  private lastPostedTab: ExtensionTabId | null = null;

  connectedCallback(): void {
    if (!this.shadowRoot) this.render();
    this.sync();
  }

  attributeChangedCallback(): void {
    this.sync();
  }

  private render(): void {
    const root = this.attachShadow({ mode: 'open' });
    const doc = this.ownerDocument;
    const activeTab = normalizeExtensionTabId(this.getAttribute('active-tab'));

    // Create style
    root.appendChild(createStyle(doc, `
      ${BASE_TOKENS}
      :host { all: initial; position: fixed; inset: 0; display: block; pointer-events: none; font-family: var(--s2-font-family); }
      :host([open]) { pointer-events: auto; }
      *, *::before, *::after { box-sizing: border-box; }
      .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.18); opacity: 0; transition: opacity var(--s2-transition-default); }
      :host([open]) .backdrop { opacity: 1; }
      .sidebar {
        position: absolute; top: 12px; right: 12px; bottom: 12px; width: min(440px, calc(100vw - 24px));
        display: flex; flex-direction: column; overflow: hidden;
        background: color-mix(in srgb, var(--s2-bg-base) 96%, transparent); color: var(--s2-content-default);
        border: 1px solid var(--s2-border-subtle); border-radius: var(--s2-radius-xl);
        box-shadow: var(--s2-shadow-elevated); transform: translateX(calc(100% + 28px));
        transition: transform var(--s2-transition-default); backdrop-filter: blur(16px);
      }
      :host([open]) .sidebar { transform: translateX(0); }
      .header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 12px; border-bottom: 1px solid var(--s2-border-subtle); background: color-mix(in srgb, var(--s2-bg-layer-1) 92%, transparent); }
      .header__brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .header__logo { width: 34px; height: 34px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(180deg, rgba(239, 112, 0, 0.9), rgba(239, 112, 0, 0.7)); color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }
      .header__logo svg { width: 18px; height: 18px; fill: currentColor; }
      .header__title { font-size: 15px; font-weight: 700; letter-spacing: 0.01em; }
      .header__subtitle { font-size: 11px; color: var(--s2-content-secondary); }
      .header__close { appearance: none; border: 1px solid var(--s2-border-subtle); background: var(--s2-bg-layer-2); color: var(--s2-content-default); width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 18px; line-height: 1; }
      .tab-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--s2-border-subtle); background: color-mix(in srgb, var(--s2-bg-layer-1) 96%, transparent); }
      .tab-bar__tab { appearance: none; border: 1px solid var(--s2-border-subtle); border-radius: var(--s2-radius-default); background: var(--s2-bg-layer-2); color: var(--s2-content-secondary); padding: 9px 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background var(--s2-transition-default), color var(--s2-transition-default), border-color var(--s2-transition-default); }
      .tab-bar__tab--active { background: color-mix(in srgb, var(--s2-accent) 18%, var(--s2-bg-layer-2)); color: var(--s2-content-default); border-color: color-mix(in srgb, var(--s2-accent) 45%, var(--s2-border-default)); }
      .viewport { position: relative; flex: 1; min-height: 0; background: var(--s2-bg-sunken); }
      iframe { border: 0; width: 100%; height: 100%; display: block; background: var(--s2-bg-base); }
      .empty-state { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; color: var(--s2-content-secondary); font-size: 13px; line-height: 1.5; }
      .empty-state[hidden] { display: none; }
    `));

    // Create backdrop
    const backdrop = doc.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.setAttribute('part', 'backdrop');
    backdrop.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('slicc-overlay-close', { bubbles: true, composed: true }));
    });
    root.appendChild(backdrop);

    // Create sidebar
    const aside = doc.createElement('aside');
    aside.className = 'sidebar';
    aside.setAttribute('part', 'sidebar');
    aside.setAttribute('aria-label', 'SLICC overlay sidebar');

    // Header
    const header = doc.createElement('header');
    header.className = 'header';

    const brand = doc.createElement('div');
    brand.className = 'header__brand';

    const logo = doc.createElement('span');
    logo.className = 'header__logo';
    logo.appendChild(createConeIconSvg(doc));
    brand.appendChild(logo);

    const titleContainer = doc.createElement('div');
    const title = doc.createElement('div');
    title.className = 'header__title';
    title.textContent = 'slicc';
    const subtitle = doc.createElement('div');
    subtitle.className = 'header__subtitle';
    subtitle.textContent = 'electron float';
    titleContainer.appendChild(title);
    titleContainer.appendChild(subtitle);
    brand.appendChild(titleContainer);
    header.appendChild(brand);

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'header__close';
    closeBtn.setAttribute('aria-label', 'Close SLICC overlay');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('slicc-overlay-close', { bubbles: true, composed: true }));
    });
    header.appendChild(closeBtn);
    aside.appendChild(header);

    // Tab bar
    const tabBar = doc.createElement('div');
    tabBar.className = 'tab-bar';
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', 'SLICC overlay tabs');

    for (const { id, label } of EXTENSION_TAB_SPECS) {
      const tabBtn = doc.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = 'tab-bar__tab' + (id === activeTab ? ' tab-bar__tab--active' : '');
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', String(id === activeTab));
      tabBtn.dataset.tab = id;
      tabBtn.textContent = label;
      this.tabButtons.set(id, tabBtn);
      tabBtn.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('slicc-overlay-select-tab', {
            bubbles: true,
            composed: true,
            detail: { tab: id },
          })
        );
      });
      tabBar.appendChild(tabBtn);
    }
    aside.appendChild(tabBar);

    // Viewport
    const viewport = doc.createElement('div');
    viewport.className = 'viewport';

    const iframe = doc.createElement('iframe');
    iframe.title = 'SLICC electron float';
    this.iframe = iframe;
    iframe.addEventListener('load', () => {
      this.frameLoaded = true;
      this.postActiveTab();
    });
    viewport.appendChild(iframe);

    const emptyState = doc.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = 'Starting the local SLICC runtime…';
    this.emptyState = emptyState;
    viewport.appendChild(emptyState);

    aside.appendChild(viewport);
    root.appendChild(aside);
    this.iframe?.addEventListener('load', () => {
      this.frameLoaded = true;
      this.postActiveTab();
    });
  }

  private sync(): void {
    const activeTab = normalizeExtensionTabId(this.getAttribute('active-tab'));
    const appUrl = this.getAttribute('app-url')?.trim() ?? DEFAULT_APP_URL;

    for (const [tabId, button] of this.tabButtons) {
      const active = tabId === activeTab;
      button.classList.toggle('tab-bar__tab--active', active);
      button.setAttribute('aria-selected', String(active));
    }

    this.emptyState?.toggleAttribute('hidden', Boolean(appUrl));
    this.syncFrameUrl(appUrl, activeTab);
    this.postActiveTab();
  }

  private syncFrameUrl(appUrl: string, activeTab: ExtensionTabId): void {
    if (!this.iframe) return;

    if (!appUrl) {
      if (this.currentAppUrl) {
        this.currentAppUrl = DEFAULT_APP_URL;
        this.frameLoaded = false;
        this.lastPostedTab = null;
        this.iframe.removeAttribute('src');
      }
      return;
    }

    if (appUrl === this.currentAppUrl) return;

    this.currentAppUrl = appUrl;
    this.frameLoaded = false;
    this.lastPostedTab = null;
    this.iframe.src = withTabQuery(appUrl, activeTab);
  }

  private postActiveTab(): void {
    if (!this.frameLoaded || !this.iframe?.contentWindow) return;

    const activeTab = normalizeExtensionTabId(this.getAttribute('active-tab'));
    if (this.lastPostedTab === activeTab) return;

    this.iframe.contentWindow.postMessage(
      {
        type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
        tab: activeTab,
      },
      '*'
    );
    this.lastPostedTab = activeTab;
  }
}

export class SliccElectronOverlayElement extends HTMLElement {
  static observedAttributes = ['open', 'active-tab', 'app-url', 'corner'];

  private state: ElectronOverlayShellState = createElectronOverlayShellState();
  private appUrlValue = DEFAULT_APP_URL;
  private syncingAttributes = false;

  connectedCallback(): void {
    this.state = createElectronOverlayShellState({
      open: this.hasAttribute('open'),
      activeTab: normalizeExtensionTabId(this.getAttribute('active-tab')),
      corner: normalizeElectronOverlayLauncherCorner(
        this.getAttribute('corner') ??
          readPersistedElectronOverlayCorner(this.ownerDocument.defaultView)
      ),
    });
    this.appUrlValue = this.getAttribute('app-url')?.trim() ?? DEFAULT_APP_URL;
    if (!this.shadowRoot) this.render();
    this.syncChildren();
    persistElectronOverlayCorner(this.ownerDocument.defaultView, this.state.corner);
    this.ownerDocument.addEventListener('keydown', this.onKeyDown, true);
  }

  disconnectedCallback(): void {
    this.ownerDocument.removeEventListener('keydown', this.onKeyDown, true);
  }

  attributeChangedCallback(): void {
    if (this.syncingAttributes) return;
    this.state = createElectronOverlayShellState({
      open: this.hasAttribute('open'),
      activeTab: normalizeExtensionTabId(this.getAttribute('active-tab')),
      corner: normalizeElectronOverlayLauncherCorner(
        this.getAttribute('corner') ??
          readPersistedElectronOverlayCorner(this.ownerDocument.defaultView)
      ),
    });
    this.appUrlValue = this.getAttribute('app-url')?.trim() ?? DEFAULT_APP_URL;
    this.syncChildren();
    persistElectronOverlayCorner(this.ownerDocument.defaultView, this.state.corner);
  }

  get open(): boolean {
    return this.state.open;
  }

  set open(value: boolean) {
    this.applyState(setElectronOverlayOpen(this.state, value));
  }

  get activeTab(): ExtensionTabId {
    return this.state.activeTab;
  }

  set activeTab(value: string) {
    this.applyState(setElectronOverlayTab(this.state, value));
  }

  get corner(): ElectronOverlayLauncherCorner {
    return this.state.corner;
  }

  set corner(value: string) {
    this.applyState(setElectronOverlayCorner(this.state, value));
  }

  get appUrl(): string {
    return this.appUrlValue;
  }

  set appUrl(value: string) {
    const next = value.trim();
    if (next === this.appUrlValue) return;
    this.appUrlValue = next;
    this.syncingAttributes = true;
    if (next) {
      this.setAttribute('app-url', next);
    } else {
      this.removeAttribute('app-url');
    }
    this.syncingAttributes = false;
    this.syncChildren();
  }

  toggle(): void {
    this.applyState(toggleElectronOverlay(this.state));
  }

  showSidebar(): void {
    this.applyState(setElectronOverlayOpen(this.state, true));
  }

  hideSidebar(): void {
    this.applyState(setElectronOverlayOpen(this.state, false));
  }

  private applyState(next: ElectronOverlayShellState): void {
    if (
      next.open === this.state.open &&
      next.activeTab === this.state.activeTab &&
      next.corner === this.state.corner
    ) {
      return;
    }

    this.state = next;
    this.syncingAttributes = true;
    this.toggleAttribute('open', next.open);
    this.setAttribute('active-tab', next.activeTab);
    this.setAttribute('corner', next.corner);
    this.syncingAttributes = false;
    this.syncChildren();
    persistElectronOverlayCorner(this.ownerDocument.defaultView, this.state.corner);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.state.open) return;
    this.hideSidebar();
  };

  private render(): void {
    const root = this.attachShadow({ mode: 'open' });
    const doc = this.ownerDocument;

    // Create style
    root.appendChild(createStyle(doc, `
      ${BASE_TOKENS}
      :host {
        all: initial;
        position: fixed;
        inset: 0;
        display: block;
        pointer-events: none;
        z-index: 2147483647;
        contain: layout style paint;
      }
    `));

    // Create launcher
    const launcher = doc.createElement(ELECTRON_OVERLAY_LAUNCHER_TAG_NAME) as SliccElectronLauncherElement;
    launcher.addEventListener('slicc-overlay-toggle', () => this.toggle());
    launcher.addEventListener('slicc-overlay-move', (event: Event) => {
      const corner = (event as CustomEvent<{ corner?: string }>).detail?.corner;
      this.applyState(setElectronOverlayCorner(this.state, corner));
    });
    root.appendChild(launcher);

    // Create sidebar
    const sidebar = doc.createElement(ELECTRON_OVERLAY_SIDEBAR_TAG_NAME) as SliccElectronSidebarElement;
    sidebar.addEventListener('slicc-overlay-close', () => this.hideSidebar());
    sidebar.addEventListener('slicc-overlay-select-tab', (event: Event) => {
      const tab = (event as CustomEvent<{ tab?: string }>).detail?.tab;
      this.applyState(setElectronOverlayTab(this.state, tab));
    });
    root.appendChild(sidebar);
  }

  private syncChildren(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const launcher = root.querySelector<SliccElectronLauncherElement>(
      ELECTRON_OVERLAY_LAUNCHER_TAG_NAME
    );
    const sidebar = root.querySelector<SliccElectronSidebarElement>(
      ELECTRON_OVERLAY_SIDEBAR_TAG_NAME
    );
    if (!launcher || !sidebar) return;

    launcher.toggleAttribute('open', this.state.open);
    launcher.setAttribute('corner', this.state.corner);
    sidebar.toggleAttribute('open', this.state.open);
    sidebar.setAttribute('active-tab', this.state.activeTab);
    if (this.appUrlValue) {
      sidebar.setAttribute('app-url', this.appUrlValue);
    } else {
      sidebar.removeAttribute('app-url');
    }
  }
}

export interface InjectElectronOverlayOptions {
  open?: boolean;
  activeTab?: string | null;
  appUrl?: string | null;
  corner?: string | null;
}

export function registerElectronOverlayElements(
  registry: CustomElementRegistry = customElements
): void {
  if (!registry.get(ELECTRON_OVERLAY_LAUNCHER_TAG_NAME)) {
    registry.define(ELECTRON_OVERLAY_LAUNCHER_TAG_NAME, SliccElectronLauncherElement);
  }
  if (!registry.get(ELECTRON_OVERLAY_SIDEBAR_TAG_NAME)) {
    registry.define(ELECTRON_OVERLAY_SIDEBAR_TAG_NAME, SliccElectronSidebarElement);
  }
  if (!registry.get(ELECTRON_OVERLAY_TAG_NAME)) {
    registry.define(ELECTRON_OVERLAY_TAG_NAME, SliccElectronOverlayElement);
  }
}

export function injectElectronOverlayShell(
  targetDocument: Document = document,
  options: InjectElectronOverlayOptions = {}
): SliccElectronOverlayElement {
  registerElectronOverlayElements(targetDocument.defaultView?.customElements ?? customElements);

  const existing = targetDocument.getElementById(ELECTRON_OVERLAY_HOST_ID);
  let overlay: SliccElectronOverlayElement;

  if (existing instanceof SliccElectronOverlayElement) {
    overlay = existing;
  } else {
    existing?.remove();
    overlay = targetDocument.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
  }

  overlay.id = ELECTRON_OVERLAY_HOST_ID;

  if (!overlay.isConnected) {
    (targetDocument.body ?? targetDocument.documentElement).appendChild(overlay);
  }

  if (typeof options.open === 'boolean') {
    overlay.open = options.open;
  }
  if (options.activeTab !== undefined) {
    overlay.activeTab = normalizeExtensionTabId(options.activeTab);
  }
  if (options.appUrl !== undefined) {
    overlay.appUrl = options.appUrl ?? DEFAULT_APP_URL;
  }
  if (options.corner !== undefined) {
    overlay.corner =
      options.corner ?? readPersistedElectronOverlayCorner(targetDocument.defaultView);
  }

  return overlay;
}

export function removeElectronOverlayShell(targetDocument: Document = document): void {
  targetDocument.getElementById(ELECTRON_OVERLAY_HOST_ID)?.remove();
}

function readPersistedElectronOverlayCorner(
  view: Window | null | undefined
): ElectronOverlayLauncherCorner {
  try {
    return normalizeElectronOverlayLauncherCorner(
      view?.sessionStorage.getItem(ELECTRON_OVERLAY_LAUNCHER_SESSION_STORAGE_KEY)
    );
  } catch {
    return normalizeElectronOverlayLauncherCorner(null);
  }
}

function persistElectronOverlayCorner(
  view: Window | null | undefined,
  corner: ElectronOverlayLauncherCorner
): void {
  try {
    view?.sessionStorage.setItem(ELECTRON_OVERLAY_LAUNCHER_SESSION_STORAGE_KEY, corner);
  } catch {
    // Some target pages may not expose sessionStorage during reinjection.
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
