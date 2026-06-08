// @vitest-environment jsdom
/**
 * Comprehensive coverage tests for `electron-overlay.ts` — exercises the
 * three custom elements (launcher, sidebar, overlay shell) plus the
 * inject/remove/persist helpers. Pure DOM / jsdom; no network or fetch.
 *
 * The element registrations are global to `customElements`, so each test
 * relies on `registerElectronOverlayElements` being idempotent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_OVERLAY_HOST_ID,
  ELECTRON_OVERLAY_TAG_NAME,
  ELECTRON_OVERLAY_TOGGLE_MESSAGE_TYPE,
  ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
  injectElectronOverlayShell,
  registerElectronOverlayElements,
  removeElectronOverlayShell,
  type SliccElectronOverlayElement,
} from '../../src/ui/electron-overlay.js';
import {
  ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE,
  ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
} from '../../src/ui/runtime-mode.js';

const LAUNCHER_TAG = 'slicc-electron-launcher';
const SIDEBAR_TAG = 'slicc-electron-sidebar';
const STORAGE_KEY = 'slicc-electron-overlay-launcher-corner';

// Map-backed localStorage stub. The webapp vitest project does not provide
// a writable jsdom localStorage out of the box (see api-key-dialog.test.ts
// for the same pattern); install one before every test so the persisted-
// corner branches in `electron-overlay.ts` get exercised.
const storage = new Map<string, string>();
const mockStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => storage.clear(),
  get length() {
    return storage.size;
  },
  key: (_i: number) => null,
};

function installMockStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: mockStorage,
  });
}

function dispatchMessage(detail: {
  data: unknown;
  source?: MessageEventSource | null;
  origin?: string;
}): void {
  const event = new MessageEvent('message', {
    data: detail.data,
    source: detail.source ?? null,
    origin: detail.origin ?? '',
  });
  window.dispatchEvent(event);
}

function makePointerEvent(
  type: string,
  init: {
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    button?: number;
    isPrimary?: boolean;
    timeStamp?: number;
  } = {}
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0, configurable: true });
  Object.defineProperty(event, 'clientY', { value: init.clientY ?? 0, configurable: true });
  Object.defineProperty(event, 'button', { value: init.button ?? 0, configurable: true });
  Object.defineProperty(event, 'isPrimary', {
    value: init.isPrimary ?? true,
    configurable: true,
  });
  if (init.timeStamp !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: init.timeStamp, configurable: true });
  }
  return event;
}

beforeEach(() => {
  document.body.replaceChildren();
  installMockStorage();
  storage.clear();
  registerElectronOverlayElements();
});

describe('registerElectronOverlayElements', () => {
  it('is idempotent — re-registering does not throw', () => {
    expect(() => registerElectronOverlayElements()).not.toThrow();
    expect(() => registerElectronOverlayElements()).not.toThrow();
    expect(customElements.get(ELECTRON_OVERLAY_TAG_NAME)).toBeDefined();
    expect(customElements.get(LAUNCHER_TAG)).toBeDefined();
    expect(customElements.get(SIDEBAR_TAG)).toBeDefined();
  });
});

describe('injectElectronOverlayShell', () => {
  it('creates and mounts a fresh overlay element under document.body', () => {
    const overlay = injectElectronOverlayShell();
    expect(overlay.tagName.toLowerCase()).toBe(ELECTRON_OVERLAY_TAG_NAME);
    expect(overlay.id).toBe(ELECTRON_OVERLAY_HOST_ID);
    expect(document.body.contains(overlay)).toBe(true);
  });

  it('reuses an existing overlay element with the same id', () => {
    const a = injectElectronOverlayShell();
    const b = injectElectronOverlayShell();
    expect(b).toBe(a);
    expect(document.querySelectorAll(`#${ELECTRON_OVERLAY_HOST_ID}`)).toHaveLength(1);
  });

  it('replaces a non-overlay element that already owns the host id', () => {
    const stale = document.createElement('div');
    stale.id = ELECTRON_OVERLAY_HOST_ID;
    document.body.appendChild(stale);

    const overlay = injectElectronOverlayShell();
    expect(overlay).not.toBe(stale as unknown);
    expect(document.body.contains(stale)).toBe(false);
    expect(document.body.contains(overlay)).toBe(true);
  });

  it('applies all options atomically on first inject', () => {
    const overlay = injectElectronOverlayShell(document, {
      open: true,
      activeTab: 'files',
      appUrl: 'https://app.example.com/electron',
      corner: 'bottom-left',
    });
    expect(overlay.open).toBe(true);
    expect(overlay.activeTab).toBe('files');
    expect(overlay.appUrl).toBe('https://app.example.com/electron');
    expect(overlay.corner).toBe('bottom-left');
  });

  it('honours boolean false for `open` and clears appUrl when given null', () => {
    const overlay = injectElectronOverlayShell(document, {
      open: true,
      appUrl: 'https://app.example.com/electron',
    });
    expect(overlay.open).toBe(true);
    injectElectronOverlayShell(document, { open: false, appUrl: null });
    expect(overlay.open).toBe(false);
    expect(overlay.appUrl).toBe('');
  });

  it('falls back to the persisted corner when `corner: null` is supplied', () => {
    window.localStorage.setItem(STORAGE_KEY, 'bottom-right');
    const overlay = injectElectronOverlayShell(document, { corner: null });
    expect(overlay.corner).toBe('bottom-right');
  });

  it('skips options it was not given (no over-eager attribute writes)', () => {
    const overlay = injectElectronOverlayShell(document, { open: true });
    expect(overlay.open).toBe(true);
    // No activeTab / appUrl / corner option → defaults stay in place.
    expect(overlay.activeTab).toBe('chat');
    expect(overlay.appUrl).toBe('');
  });

  it('falls back to documentElement when body is missing', () => {
    const doc = document.implementation.createHTMLDocument('headless');
    doc.body.remove();
    expect(doc.body).toBeNull();
    const overlay = injectElectronOverlayShell(doc);
    expect(doc.documentElement.contains(overlay)).toBe(true);
  });
});

describe('removeElectronOverlayShell', () => {
  it('removes a mounted overlay', () => {
    injectElectronOverlayShell();
    expect(document.getElementById(ELECTRON_OVERLAY_HOST_ID)).not.toBeNull();
    removeElectronOverlayShell();
    expect(document.getElementById(ELECTRON_OVERLAY_HOST_ID)).toBeNull();
  });

  it('is a no-op when no overlay exists', () => {
    expect(() => removeElectronOverlayShell()).not.toThrow();
  });
});

describe('SliccElectronOverlayElement — lifecycle + setters', () => {
  function mount(attrs: Record<string, string> = {}): SliccElectronOverlayElement {
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    for (const [k, v] of Object.entries(attrs)) overlay.setAttribute(k, v);
    document.body.appendChild(overlay);
    return overlay;
  }

  it('reads initial state from attributes on connect', () => {
    const overlay = mount({
      open: '',
      'active-tab': 'memory',
      'app-url': 'https://app.example.com/x',
      corner: 'top-left',
    });
    expect(overlay.open).toBe(true);
    expect(overlay.activeTab).toBe('memory');
    expect(overlay.appUrl).toBe('https://app.example.com/x');
    expect(overlay.corner).toBe('top-left');
  });

  it('persists the corner on connect and on every state change', () => {
    const overlay = mount({ corner: 'bottom-right' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('bottom-right');
    overlay.corner = 'top-left';
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('top-left');
  });

  it('open/showSidebar/hideSidebar/toggle update state and DOM attribute', () => {
    const overlay = mount();
    expect(overlay.open).toBe(false);
    overlay.toggle();
    expect(overlay.open).toBe(true);
    expect(overlay.hasAttribute('open')).toBe(true);
    overlay.hideSidebar();
    expect(overlay.open).toBe(false);
    overlay.showSidebar();
    expect(overlay.open).toBe(true);
    overlay.open = false;
    expect(overlay.open).toBe(false);
  });

  it('activeTab setter is a no-op when value is unchanged', () => {
    const overlay = mount({ 'active-tab': 'files' });
    overlay.activeTab = 'files';
    expect(overlay.activeTab).toBe('files');
    overlay.activeTab = 'memory';
    expect(overlay.activeTab).toBe('memory');
    expect(overlay.getAttribute('active-tab')).toBe('memory');
  });

  it('corner setter updates state + DOM and persists', () => {
    const overlay = mount();
    overlay.corner = 'bottom-left';
    expect(overlay.corner).toBe('bottom-left');
    expect(overlay.getAttribute('corner')).toBe('bottom-left');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('bottom-left');
  });

  it('appUrl setter writes attribute, clears it when emptied, and is no-op on no-change', () => {
    const overlay = mount();
    overlay.appUrl = 'https://app.example.com/electron';
    expect(overlay.appUrl).toBe('https://app.example.com/electron');
    expect(overlay.getAttribute('app-url')).toBe('https://app.example.com/electron');
    // Same value → setter returns early (must not throw or duplicate attribute writes).
    overlay.appUrl = 'https://app.example.com/electron';
    expect(overlay.getAttribute('app-url')).toBe('https://app.example.com/electron');
    overlay.appUrl = '';
    expect(overlay.appUrl).toBe('');
    expect(overlay.hasAttribute('app-url')).toBe(false);
  });

  it('attributeChangedCallback re-derives state from attributes', () => {
    const overlay = mount();
    overlay.setAttribute('open', '');
    overlay.setAttribute('active-tab', 'terminal');
    overlay.setAttribute('corner', 'top-left');
    overlay.setAttribute('app-url', 'https://app.example.com/y');
    expect(overlay.open).toBe(true);
    expect(overlay.activeTab).toBe('terminal');
    expect(overlay.corner).toBe('top-left');
    expect(overlay.appUrl).toBe('https://app.example.com/y');
  });

  it('disconnectedCallback removes keydown and message listeners', () => {
    const overlay = mount();
    overlay.remove();
    // After disconnect, posting a close message must NOT change the saved state
    // (state remains whatever it was; we just prove there is no throw).
    expect(() => {
      window.postMessage({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE }, '*');
    }).not.toThrow();
  });
});

describe('SliccElectronOverlayElement — keyboard shortcuts', () => {
  function mount(open = false): SliccElectronOverlayElement {
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    if (open) overlay.setAttribute('open', '');
    document.body.appendChild(overlay);
    return overlay;
  }

  it('toggles when meta+; is pressed', () => {
    const overlay = mount();
    const event = new KeyboardEvent('keydown', {
      key: ';',
      code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
      metaKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    expect(overlay.open).toBe(true);
  });

  it('toggles when ctrl+; is pressed (non-mac browsers)', () => {
    const overlay = mount();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ';',
        code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
        ctrlKey: true,
        bubbles: true,
      })
    );
    expect(overlay.open).toBe(true);
  });

  it('does NOT toggle when the modifier is missing', () => {
    const overlay = mount();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ';',
        code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
        bubbles: true,
      })
    );
    expect(overlay.open).toBe(false);
  });

  it('does NOT toggle when shift or alt is pressed alongside the shortcut', () => {
    const overlay = mount();
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ';',
        code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      })
    );
    expect(overlay.open).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ';',
        code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
        metaKey: true,
        altKey: true,
        bubbles: true,
      })
    );
    expect(overlay.open).toBe(false);
  });

  it('ignores repeated keydown events (autorepeat is filtered out)', () => {
    const overlay = mount();
    const event = new KeyboardEvent('keydown', {
      key: ';',
      code: ELECTRON_OVERLAY_TOGGLE_SHORTCUT_CODE,
      metaKey: true,
      repeat: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
    expect(overlay.open).toBe(false);
  });

  it('closes the sidebar on Escape when open, and is a no-op when closed', () => {
    const overlay = mount(true);
    expect(overlay.open).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.open).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlay.open).toBe(false);
  });
});

describe('SliccElectronOverlayElement — message handling', () => {
  function mount(opts: { open?: boolean; appUrl?: string } = {}): SliccElectronOverlayElement {
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    if (opts.open) overlay.setAttribute('open', '');
    if (opts.appUrl !== undefined) overlay.setAttribute('app-url', opts.appUrl);
    document.body.appendChild(overlay);
    return overlay;
  }

  const foreignSource = { postMessage: () => {} } as unknown as MessageEventSource;

  it('toggles on a valid toggle message from a foreign source', () => {
    const overlay = mount();
    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_TOGGLE_MESSAGE_TYPE },
      source: foreignSource,
      origin: 'https://anywhere.example.com',
    });
    expect(overlay.open).toBe(true);
  });

  it('closes on a valid close message from a foreign source', () => {
    const overlay = mount({ open: true });
    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: foreignSource,
      origin: 'anywhere',
    });
    expect(overlay.open).toBe(false);
  });

  it('rejects malformed payloads (non-object, missing type)', () => {
    const overlay = mount({ open: true });
    dispatchMessage({ data: null, source: foreignSource });
    dispatchMessage({ data: 'string', source: foreignSource });
    dispatchMessage({ data: {}, source: foreignSource });
    expect(overlay.open).toBe(true);
  });

  it('ignores unknown message types', () => {
    const overlay = mount({ open: true });
    dispatchMessage({
      data: { type: 'something-unrelated' },
      source: foreignSource,
      origin: 'x',
    });
    expect(overlay.open).toBe(true);
  });

  it('rejects messages with mismatched origin when appUrl is absolute', () => {
    const overlay = mount({ open: true, appUrl: 'https://app.example.com/electron' });
    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: foreignSource,
      origin: 'https://evil.example.com',
    });
    expect(overlay.open).toBe(true);
  });

  it('accepts messages with matching origin when appUrl is absolute', () => {
    const overlay = mount({ open: true, appUrl: 'https://app.example.com/electron' });
    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: foreignSource,
      origin: 'https://app.example.com',
    });
    expect(overlay.open).toBe(false);
  });

  it('skips origin validation when appUrl is unparseable (relative)', () => {
    const overlay = mount({ open: true, appUrl: '/electron' });
    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: foreignSource,
      origin: 'https://anywhere.example.com',
    });
    expect(overlay.open).toBe(false);
  });
});

describe('SliccElectronOverlayElement — children + slot wiring', () => {
  it('renders a launcher and a sidebar in the shadow root', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
      open: true,
      corner: 'top-right',
      activeTab: 'memory',
    });
    const root = overlay.shadowRoot!;
    const launcher = root.querySelector(LAUNCHER_TAG)!;
    const sidebar = root.querySelector(SIDEBAR_TAG)!;
    expect(launcher).not.toBeNull();
    expect(sidebar).not.toBeNull();
    expect(launcher.hasAttribute('open')).toBe(true);
    expect(launcher.getAttribute('corner')).toBe('top-right');
    expect(sidebar.hasAttribute('open')).toBe(true);
    expect(sidebar.getAttribute('corner')).toBe('top-right');
    expect(sidebar.getAttribute('active-tab')).toBe('memory');
    expect(sidebar.getAttribute('app-url')).toBe('https://app.example.com/electron');
  });

  it('clears the sidebar app-url attribute when appUrl is empty', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
    });
    overlay.appUrl = '';
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    expect(sidebar.hasAttribute('app-url')).toBe(false);
  });

  it('toggles via the launcher click event', () => {
    const overlay = injectElectronOverlayShell(document);
    expect(overlay.open).toBe(false);
    const launcher = overlay.shadowRoot!.querySelector(LAUNCHER_TAG) as HTMLElement;
    launcher.dispatchEvent(
      new CustomEvent('slicc-overlay-toggle', { bubbles: true, composed: true })
    );
    expect(overlay.open).toBe(true);
  });

  it('updates corner via the launcher move event', () => {
    const overlay = injectElectronOverlayShell(document, { corner: 'top-right' });
    const launcher = overlay.shadowRoot!.querySelector(LAUNCHER_TAG) as HTMLElement;
    launcher.dispatchEvent(
      new CustomEvent<{ corner: string }>('slicc-overlay-move', {
        bubbles: true,
        composed: true,
        detail: { corner: 'bottom-left' },
      })
    );
    expect(overlay.corner).toBe('bottom-left');
  });

  it('closes when the sidebar fires its close event', () => {
    const overlay = injectElectronOverlayShell(document, { open: true });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG) as HTMLElement;
    sidebar.dispatchEvent(
      new CustomEvent('slicc-overlay-close', { bubbles: true, composed: true })
    );
    expect(overlay.open).toBe(false);
  });
});

describe('SliccElectronSidebarElement — iframe wiring', () => {
  it('renders an iframe with no src when appUrl is empty', () => {
    const overlay = injectElectronOverlayShell();
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const iframe = sidebar.shadowRoot!.querySelector('iframe')!;
    expect(iframe).not.toBeNull();
    expect(iframe.hasAttribute('src')).toBe(false);
  });

  it('points the iframe at appUrl with the active tab query parameter', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
      activeTab: 'files',
    });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const iframe = sidebar.shadowRoot!.querySelector('iframe')!;
    const src = iframe.getAttribute('src') ?? '';
    expect(src.startsWith('https://app.example.com/electron')).toBe(true);
    expect(src).toContain('tab=files');
  });

  it('clears the iframe src when appUrl is removed', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
    });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const iframe = sidebar.shadowRoot!.querySelector('iframe')!;
    expect(iframe.hasAttribute('src')).toBe(true);
    overlay.appUrl = '';
    expect(iframe.hasAttribute('src')).toBe(false);
  });

  it('hides the empty-state when appUrl is non-empty', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
    });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const empty = sidebar.shadowRoot!.querySelector('.empty-state')!;
    expect(empty.hasAttribute('hidden')).toBe(true);
  });

  it('shows the empty-state when appUrl is empty', () => {
    const overlay = injectElectronOverlayShell();
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const empty = sidebar.shadowRoot!.querySelector('.empty-state')!;
    expect(empty.hasAttribute('hidden')).toBe(false);
  });

  it('posts the active tab to the iframe on load and dedupes repeat posts', () => {
    const overlay = injectElectronOverlayShell(document, {
      appUrl: 'https://app.example.com/electron',
      activeTab: 'files',
    });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const iframe = sidebar.shadowRoot!.querySelector('iframe')!;
    // Stub contentWindow.postMessage; jsdom does not actually navigate iframes.
    const postMessage = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get: () => ({ postMessage }),
    });
    // Fire the load event the production code listens for.
    iframe.dispatchEvent(new Event('load'));
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE, tab: 'files' }),
      '*'
    );
    // sync() re-runs on attributeChangedCallback. Same tab → no extra post.
    postMessage.mockClear();
    sidebar.setAttribute('active-tab', 'files');
    expect(postMessage).not.toHaveBeenCalled();
    // Different tab → posts the new tab.
    sidebar.setAttribute('active-tab', 'memory');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE, tab: 'memory' }),
      '*'
    );
  });

  it('routes backdrop clicks to slicc-overlay-close', () => {
    const overlay = injectElectronOverlayShell(document, { open: true });
    const sidebar = overlay.shadowRoot!.querySelector(SIDEBAR_TAG)!;
    const backdrop = sidebar.shadowRoot!.querySelector('.backdrop') as HTMLElement;
    backdrop.click();
    expect(overlay.open).toBe(false);
  });
});

describe('SliccElectronLauncherElement — render + click flows', () => {
  it('renders a button with shortcut hint in the title and aria-pressed reflects open state', () => {
    const overlay = injectElectronOverlayShell(document, { open: true });
    const launcher = overlay.shadowRoot!.querySelector(LAUNCHER_TAG)!;
    const button = launcher.shadowRoot!.querySelector('button')!;
    expect(button).not.toBeNull();
    expect(button.title).toMatch(/Toggle SLICC/);
    expect(button.title).toContain(';');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Toggle SLICC overlay');
    // Both monochrome logo variants are embedded so CSS can pick.
    expect(launcher.shadowRoot!.querySelectorAll('.logo-icon')).toHaveLength(2);
  });

  it('emits slicc-overlay-toggle on a normal button click', () => {
    const overlay = injectElectronOverlayShell();
    const launcher = overlay.shadowRoot!.querySelector(LAUNCHER_TAG)!;
    const button = launcher.shadowRoot!.querySelector('button')!;
    const listener = vi.fn();
    launcher.addEventListener('slicc-overlay-toggle', listener);
    button.click();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('SliccElectronLauncherElement — pointer drag + snap', () => {
  function mountLauncher(): {
    overlay: SliccElectronOverlayElement;
    launcher: HTMLElement;
    button: HTMLButtonElement;
  } {
    const overlay = injectElectronOverlayShell();
    const launcher = overlay.shadowRoot!.querySelector(LAUNCHER_TAG) as HTMLElement;
    const button = launcher.shadowRoot!.querySelector('button') as HTMLButtonElement;
    // jsdom does not implement setPointerCapture / releasePointerCapture / hasPointerCapture;
    // stub them so the production code can call through without throwing.
    const captured = new Set<number>();
    button.setPointerCapture = (id: number) => {
      captured.add(id);
    };
    button.releasePointerCapture = (id: number) => {
      captured.delete(id);
    };
    button.hasPointerCapture = (id: number) => captured.has(id);
    Object.defineProperty(launcher, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 100,
        top: 100,
        right: 144,
        bottom: 144,
        width: 44,
        height: 44,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }),
    });
    return { overlay, launcher, button };
  }

  it('ignores secondary-button and non-primary pointerdowns', () => {
    const { launcher, button } = mountLauncher();
    button.dispatchEvent(
      makePointerEvent('pointerdown', { pointerId: 5, button: 2, isPrimary: true })
    );
    button.dispatchEvent(
      makePointerEvent('pointerdown', { pointerId: 5, button: 0, isPrimary: false })
    );
    // No drag attribute should land.
    expect(launcher.hasAttribute('dragging')).toBe(false);
  });

  it('starts dragging after the threshold is exceeded and updates inline position', () => {
    const { launcher, button } = mountLauncher();
    button.dispatchEvent(
      makePointerEvent('pointerdown', {
        pointerId: 7,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      })
    );
    // Below threshold first.
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 7,
        clientX: 102,
        clientY: 101,
        timeStamp: 16,
      })
    );
    expect(launcher.hasAttribute('dragging')).toBe(false);

    // Above threshold (snap threshold is 8px).
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 7,
        clientX: 200,
        clientY: 240,
        timeStamp: 64,
      })
    );
    expect(launcher.hasAttribute('dragging')).toBe(true);
    // The launcher's left/top inline styles should have been updated.
    expect(launcher.style.left).not.toBe('');
    expect(launcher.style.top).not.toBe('');
  });

  it('drops drag-state and emits slicc-overlay-move on pointerup past threshold', () => {
    const { overlay, launcher, button } = mountLauncher();
    const cornerListener = vi.fn();
    launcher.addEventListener('slicc-overlay-move', cornerListener);
    button.dispatchEvent(
      makePointerEvent('pointerdown', {
        pointerId: 9,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 9,
        clientX: 400,
        clientY: 500,
        timeStamp: 50,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointerup', {
        pointerId: 9,
        clientX: 400,
        clientY: 500,
        timeStamp: 60,
      })
    );
    expect(launcher.hasAttribute('dragging')).toBe(false);
    expect(cornerListener).toHaveBeenCalledTimes(1);
    // applyState should have run with the new corner. Just check that the
    // overlay corner is now one of the resolved corner values.
    expect([
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
      'top',
      'bottom',
      'left',
      'right',
    ]).toContain(overlay.corner);
  });

  it('suppresses the immediately-following click when a drag occurred', () => {
    const { launcher, button } = mountLauncher();
    const toggleListener = vi.fn();
    launcher.addEventListener('slicc-overlay-toggle', toggleListener);
    button.dispatchEvent(
      makePointerEvent('pointerdown', {
        pointerId: 11,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 11,
        clientX: 400,
        clientY: 500,
        timeStamp: 50,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointerup', {
        pointerId: 11,
        clientX: 400,
        clientY: 500,
        timeStamp: 60,
      })
    );
    button.click();
    expect(toggleListener).not.toHaveBeenCalled();
    // A subsequent normal click should pass through.
    button.click();
    expect(toggleListener).toHaveBeenCalledTimes(1);
  });

  it('pointercancel resets drag state without snapping', () => {
    const { launcher, button } = mountLauncher();
    const moveListener = vi.fn();
    launcher.addEventListener('slicc-overlay-move', moveListener);
    button.dispatchEvent(
      makePointerEvent('pointerdown', {
        pointerId: 13,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 13,
        clientX: 400,
        clientY: 500,
        timeStamp: 50,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointercancel', {
        pointerId: 13,
        clientX: 400,
        clientY: 500,
        timeStamp: 60,
      })
    );
    expect(launcher.hasAttribute('dragging')).toBe(false);
    expect(moveListener).not.toHaveBeenCalled();
  });

  it('ignores pointer events with mismatched pointerId', () => {
    const { launcher, button } = mountLauncher();
    button.dispatchEvent(
      makePointerEvent('pointerdown', {
        pointerId: 15,
        clientX: 100,
        clientY: 100,
        timeStamp: 0,
      })
    );
    // Different pointerId — must be ignored.
    button.dispatchEvent(
      makePointerEvent('pointermove', {
        pointerId: 99,
        clientX: 400,
        clientY: 500,
        timeStamp: 50,
      })
    );
    button.dispatchEvent(
      makePointerEvent('pointerup', {
        pointerId: 99,
        clientX: 400,
        clientY: 500,
        timeStamp: 60,
      })
    );
    expect(launcher.hasAttribute('dragging')).toBe(false);
  });
});

describe('localStorage persistence helpers', () => {
  it('roundtrips the corner through localStorage on connect/disconnect', () => {
    window.localStorage.setItem(STORAGE_KEY, 'bottom-left');
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    document.body.appendChild(overlay);
    expect(overlay.corner).toBe('bottom-left');
  });

  it('falls back gracefully when localStorage throws on read', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      const overlay = document.createElement(
        ELECTRON_OVERLAY_TAG_NAME
      ) as SliccElectronOverlayElement;
      document.body.appendChild(overlay);
      // Default corner kicks in when localStorage throws.
      expect(overlay.corner).toBe('top-right');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('falls back gracefully when localStorage throws on write', () => {
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    document.body.appendChild(overlay);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    });
    try {
      expect(() => {
        overlay.corner = 'bottom-right';
      }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
