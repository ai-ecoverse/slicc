import { beforeEach, describe, expect, it, vi } from 'vitest';
import { injectSliccLauncher, removeSliccLauncher, SLICC_LAUNCHER_HOST_ID } from '../src/inject.js';
import {
  DEFAULT_LAUNCHER_CORNER,
  DEFAULT_LAUNCHER_FOLLOWER_STATUS,
  LAUNCHER_CORNERS,
  LAUNCHER_FOLLOWER_STATUS_ATTR,
  LAUNCHER_FOLLOWER_STATUSES,
  normalizeLauncherCorner,
  normalizeLauncherFollowerStatus,
  resolveLauncherCorner,
  shouldSnapLauncher,
} from '../src/launcher-state.js';
import { SliccLauncher } from '../src/slicc-launcher.js';

function mount(attrs: Record<string, string> = {}): SliccLauncher {
  const el = document.createElement('slicc-launcher') as SliccLauncher;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

const STORAGE_KEY = 'slicc-launcher-corner';

describe('launcher-state', () => {
  it('normalizes unknown corners to the default', () => {
    expect(normalizeLauncherCorner('top-right')).toBe('top-right');
    expect(normalizeLauncherCorner('bottom-left')).toBe('bottom-left');
    expect(normalizeLauncherCorner('left')).toBe('left');
    expect(normalizeLauncherCorner('nonsense')).toBe(DEFAULT_LAUNCHER_CORNER);
    expect(normalizeLauncherCorner(null)).toBe(DEFAULT_LAUNCHER_CORNER);
    expect(normalizeLauncherCorner(undefined, 'left')).toBe('left');
  });

  it('shouldSnapLauncher honors the distance + flick thresholds', () => {
    expect(shouldSnapLauncher(0, 0)).toBe(false);
    expect(shouldSnapLauncher(5, 0)).toBe(false);
    // Past the drag threshold, snap regardless of velocity.
    expect(shouldSnapLauncher(6, 0)).toBe(true);
    expect(shouldSnapLauncher(12, 0.1)).toBe(true);
    // A fast flick with a smaller distance does not snap until the flick
    // distance threshold is also met.
    expect(shouldSnapLauncher(3, 2)).toBe(false);
  });

  it('resolveLauncherCorner picks corner quadrants and edge midpoints', () => {
    const v = { viewportWidth: 1000, viewportHeight: 800 };
    expect(resolveLauncherCorner({ clientX: 10, clientY: 10, ...v })).toBe('top-left');
    expect(resolveLauncherCorner({ clientX: 990, clientY: 10, ...v })).toBe('top-right');
    expect(resolveLauncherCorner({ clientX: 10, clientY: 790, ...v })).toBe('bottom-left');
    expect(resolveLauncherCorner({ clientX: 990, clientY: 790, ...v })).toBe('bottom-right');
    // Center of an axis → nearest edge midpoint.
    expect(resolveLauncherCorner({ clientX: 500, clientY: 10, ...v })).toBe('top');
    expect(resolveLauncherCorner({ clientX: 500, clientY: 790, ...v })).toBe('bottom');
    expect(resolveLauncherCorner({ clientX: 10, clientY: 400, ...v })).toBe('left');
    expect(resolveLauncherCorner({ clientX: 990, clientY: 400, ...v })).toBe('right');
  });

  it('exposes a complete corner set', () => {
    expect(new Set(LAUNCHER_CORNERS).size).toBe(8);
  });

  it('normalizes follower-status to the disconnected default for absent/invalid values', () => {
    expect(normalizeLauncherFollowerStatus('connected')).toBe('connected');
    expect(normalizeLauncherFollowerStatus('disconnected')).toBe('disconnected');
    expect(normalizeLauncherFollowerStatus('error')).toBe('error');
    expect(normalizeLauncherFollowerStatus(null)).toBe(DEFAULT_LAUNCHER_FOLLOWER_STATUS);
    expect(normalizeLauncherFollowerStatus('')).toBe(DEFAULT_LAUNCHER_FOLLOWER_STATUS);
    expect(normalizeLauncherFollowerStatus('nonsense')).toBe(DEFAULT_LAUNCHER_FOLLOWER_STATUS);
    expect(DEFAULT_LAUNCHER_FOLLOWER_STATUS).toBe('disconnected');
    expect(new Set(LAUNCHER_FOLLOWER_STATUSES)).toEqual(
      new Set(['disconnected', 'connected', 'error'])
    );
  });
});

describe('slicc-launcher', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-launcher')).toBe(SliccLauncher);
  });

  it('builds a shadow shell with launcher + sidebar + backdrop parts', () => {
    const el = mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('button.launcher[part="launcher"]')).not.toBeNull();
    expect(root.querySelector('aside.sidebar[part="sidebar"]')).not.toBeNull();
    expect(root.querySelector('.backdrop[part="backdrop"]')).not.toBeNull();
    expect(root.querySelector('iframe')).not.toBeNull();
  });

  it('renders the Sliccy mono logo (both color-scheme variants) instead of a hamburger glyph', () => {
    const el = mount();
    const root = el.shadowRoot as ShadowRoot;
    const button = root.querySelector('button.launcher') as HTMLButtonElement;
    expect(root.querySelector('.glyph')).toBeNull();
    // Each follower-status state wrapper carries a dark + light variant, so a
    // three-state launcher renders 3 dark + 3 light SVGs side-by-side; CSS
    // gates which one is visible.
    const dark = button.querySelectorAll('.logo-for-dark svg');
    const light = button.querySelectorAll('.logo-for-light svg');
    expect(dark.length).toBe(3);
    expect(light.length).toBe(3);
    // The Sliccy assets ship a 1024×1024 viewBox — sanity-check the import
    // actually reached the SVG (parseSvg(...) preserved the root attribute).
    expect((dark[0] as SVGElement).getAttribute('viewBox')).toBe('0 0 1024 1024');
  });

  it('makes the whole button the click target: logo, svg, and tab-label are pointer-transparent', () => {
    const el = mount();
    const root = el.shadowRoot as ShadowRoot;
    const button = root.querySelector('button.launcher') as HTMLElement;
    const logo = root.querySelector('.logo') as HTMLElement;
    const svg = root.querySelector('.logo-for-dark svg') as unknown as HTMLElement;
    const tabLabel = root.querySelector('.tab-label') as HTMLElement;
    // The button itself is the sole interactive surface.
    expect(getComputedStyle(button).pointerEvents).toBe('auto');
    // Every inner element is transparent to pointer events, so hover/clicks over
    // the icon fall through to the button (uniform grab cursor, full click area).
    expect(getComputedStyle(logo).pointerEvents).toBe('none');
    expect(getComputedStyle(svg).pointerEvents).toBe('none');
    expect(getComputedStyle(tabLabel).pointerEvents).toBe('none');
  });

  it('renders one wrapper per follower-status state', () => {
    const el = mount();
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('.logo-state-disconnected')).not.toBeNull();
    expect(root.querySelector('.logo-state-connected')).not.toBeNull();
    expect(root.querySelector('.logo-state-error')).not.toBeNull();
  });

  it('shows a "SLICC" tab label at edge-midpoint corners and hides it at true corners', () => {
    const el = mount();
    const label = el.shadowRoot?.querySelector('.tab-label') as HTMLElement;
    expect(label.textContent).toBe('SLICC');
    el.corner = 'top-right';
    expect(getComputedStyle(label).display).toBe('none');
    el.corner = 'top';
    expect(getComputedStyle(label).display).toBe('block');
    el.corner = 'left';
    expect(getComputedStyle(label).display).toBe('block');
    el.corner = 'bottom-left';
    expect(getComputedStyle(label).display).toBe('none');
  });

  it('renders the button as a rounded tab (not a circle) at edge midpoints', () => {
    const el = mount({ corner: 'top' });
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLElement;
    const style = getComputedStyle(button);
    // Tab mode: rounded only on the two corners NOT touching the viewport edge.
    expect(style.borderTopLeftRadius).toBe('0px');
    expect(style.borderTopRightRadius).toBe('0px');
    expect(style.borderBottomLeftRadius).toBe('10px');
    expect(style.borderBottomRightRadius).toBe('10px');
    // The rect is no longer the 44×44 pill — width tracks content.
    const rect = button.getBoundingClientRect();
    expect(rect.height).toBeLessThan(44);
  });

  it('keeps the pill shape (44px circle) at true corners', () => {
    const el = mount({ corner: 'top-right' });
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLElement;
    const rect = button.getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(44);
    expect(Math.round(rect.height)).toBe(44);
  });

  it('hides the sidebar + backdrop while the host carries [dragging] so the iframe does not flicker', () => {
    const el = mount();
    el.show();
    const sidebar = el.shadowRoot?.querySelector('.sidebar') as HTMLElement;
    const backdrop = el.shadowRoot?.querySelector('.backdrop') as HTMLElement;
    expect(getComputedStyle(sidebar).visibility).toBe('visible');
    expect(getComputedStyle(backdrop).visibility).toBe('visible');
    el.setAttribute('dragging', '');
    expect(getComputedStyle(sidebar).visibility).toBe('hidden');
    expect(getComputedStyle(backdrop).visibility).toBe('hidden');
    el.removeAttribute('dragging');
    expect(getComputedStyle(sidebar).visibility).toBe('visible');
  });

  it('keeps its CSS in a constructable adopted stylesheet (no <style> node)', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('falls back to the default corner when no attribute and no storage', () => {
    const el = mount();
    expect(el.getAttribute('corner')).toBe(DEFAULT_LAUNCHER_CORNER);
    expect(el.corner).toBe(DEFAULT_LAUNCHER_CORNER);
  });

  it('reads the persisted corner from localStorage on connect', () => {
    localStorage.setItem(STORAGE_KEY, 'bottom-left');
    const el = mount();
    expect(el.getAttribute('corner')).toBe('bottom-left');
  });

  it('reflects open between the attribute, property and CSS host state', () => {
    const el = mount();
    expect(el.open).toBe(false);
    el.show();
    expect(el.open).toBe(true);
    expect(el.hasAttribute('open')).toBe(true);
    el.hide();
    expect(el.open).toBe(false);
    el.toggle();
    expect(el.open).toBe(true);
  });

  it('reflects app-url and loads / unloads the iframe accordingly', () => {
    const el = mount();
    const iframe = el.shadowRoot?.querySelector('iframe') as HTMLIFrameElement;
    const empty = el.shadowRoot?.querySelector('.empty') as HTMLElement;
    expect(iframe.hasAttribute('src')).toBe(false);
    expect(empty.hasAttribute('hidden')).toBe(false);
    el.appUrl = 'about:blank';
    expect(iframe.getAttribute('src')).toBe('about:blank');
    expect(empty.hasAttribute('hidden')).toBe(true);
    el.appUrl = null;
    expect(iframe.hasAttribute('src')).toBe(false);
  });

  it('clicking the button toggles open and fires slicc-launcher-toggle', () => {
    const el = mount();
    const toggles: boolean[] = [];
    el.addEventListener('slicc-launcher-toggle', (e) =>
      toggles.push((e as CustomEvent<{ open: boolean }>).detail.open)
    );
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement;
    button.click();
    expect(el.open).toBe(true);
    button.click();
    expect(el.open).toBe(false);
    expect(toggles).toEqual([true, false]);
  });

  it('double-clicking the button fires slicc-launcher-focus without changing open state', () => {
    const el = mount();
    const focuses: number[] = [];
    el.addEventListener('slicc-launcher-focus', () => focuses.push(1));
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(focuses.length).toBe(1);
    // dblclick alone does not flip open — that comes only from explicit clicks.
    expect(el.open).toBe(false);
  });

  it('emits composed + bubbling events that escape the shadow root', () => {
    const el = mount();
    const seen: string[] = [];
    document.addEventListener('slicc-launcher-toggle', () => seen.push('toggle'), { once: true });
    document.addEventListener('slicc-launcher-focus', () => seen.push('focus'), { once: true });
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement;
    button.click();
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(seen).toEqual(['toggle', 'focus']);
  });

  it('clicking the backdrop closes the launcher', () => {
    const el = mount();
    el.show();
    const backdrop = el.shadowRoot?.querySelector('.backdrop') as HTMLElement;
    backdrop.click();
    expect(el.open).toBe(false);
  });

  it('persists the corner to localStorage when the corner attribute changes', () => {
    const el = mount();
    el.corner = 'bottom-left';
    expect(localStorage.getItem(STORAGE_KEY)).toBe('bottom-left');
    el.corner = 'top';
    expect(localStorage.getItem(STORAGE_KEY)).toBe('top');
  });

  it('survives a missing localStorage (no throw on hostile pages)', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      const el = mount();
      el.corner = 'top';
      expect(el.getAttribute('corner')).toBe('top');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('positions the button against the top-right viewport edge by default (real Chromium)', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLElement;
    const rect = button.getBoundingClientRect();
    expect(rect.top).toBeLessThan(40);
    expect(window.innerWidth - rect.right).toBeLessThan(40);
  });

  it('defaults follower-status to disconnected when the attribute is absent', () => {
    const el = mount();
    expect(el.hasAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe(false);
    expect(el.followerStatus).toBe('disconnected');
    const root = el.shadowRoot as ShadowRoot;
    const disconnected = root.querySelector('.logo-state-disconnected') as HTMLElement;
    const connected = root.querySelector('.logo-state-connected') as HTMLElement;
    const error = root.querySelector('.logo-state-error') as HTMLElement;
    expect(getComputedStyle(disconnected).display).toBe('contents');
    expect(getComputedStyle(connected).display).toBe('none');
    expect(getComputedStyle(error).display).toBe('none');
  });

  it('swaps the visible wrapper as follower-status changes', () => {
    const el = mount();
    const root = el.shadowRoot as ShadowRoot;
    const disconnected = root.querySelector('.logo-state-disconnected') as HTMLElement;
    const connected = root.querySelector('.logo-state-connected') as HTMLElement;
    const error = root.querySelector('.logo-state-error') as HTMLElement;

    el.followerStatus = 'connected';
    expect(el.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe('connected');
    expect(getComputedStyle(disconnected).display).toBe('none');
    expect(getComputedStyle(connected).display).toBe('contents');
    expect(getComputedStyle(error).display).toBe('none');

    el.followerStatus = 'error';
    expect(el.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe('error');
    expect(getComputedStyle(disconnected).display).toBe('none');
    expect(getComputedStyle(connected).display).toBe('none');
    expect(getComputedStyle(error).display).toBe('contents');

    el.followerStatus = 'disconnected';
    expect(el.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe('disconnected');
    expect(getComputedStyle(disconnected).display).toBe('contents');
  });

  it('coerces an invalid follower-status attribute back to disconnected', () => {
    const el = mount({ 'follower-status': 'bogus' });
    // attributeChangedCallback normalizes the bad value in place.
    expect(el.getAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe('disconnected');
    expect(el.followerStatus).toBe('disconnected');
    const disconnected = el.shadowRoot?.querySelector('.logo-state-disconnected') as HTMLElement;
    expect(getComputedStyle(disconnected).display).toBe('contents');
  });

  it('removing the follower-status attribute via the setter clears it', () => {
    const el = mount({ 'follower-status': 'connected' });
    expect(el.followerStatus).toBe('connected');
    el.followerStatus = null;
    expect(el.hasAttribute(LAUNCHER_FOLLOWER_STATUS_ATTR)).toBe(false);
    expect(el.followerStatus).toBe('disconnected');
  });

  it('keeps follower-status swap working in tab mode (no layout shift)', () => {
    const el = mount({ corner: 'top' });
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLElement;
    const before = button.getBoundingClientRect();
    el.followerStatus = 'connected';
    const afterConnected = button.getBoundingClientRect();
    el.followerStatus = 'error';
    const afterError = button.getBoundingClientRect();
    expect(afterConnected.width).toBe(before.width);
    expect(afterConnected.height).toBe(before.height);
    expect(afterError.width).toBe(before.width);
    expect(afterError.height).toBe(before.height);
  });

  it('vi spy on focus event detail is undefined (it has no payload)', () => {
    const el = mount();
    const handler = vi.fn();
    el.addEventListener('slicc-launcher-focus', handler);
    const button = el.shadowRoot?.querySelector('button.launcher') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
    const evt = handler.mock.calls[0][0] as CustomEvent;
    expect(evt.bubbles).toBe(true);
    expect(evt.composed).toBe(true);
  });
});

describe('inject', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mounts a launcher with the overlay host id and applies options', () => {
    const launcher = injectSliccLauncher(document, {
      open: true,
      appUrl: 'https://example.test/app',
      corner: 'bottom-left',
    });
    expect(launcher).toBeInstanceOf(SliccLauncher);
    expect(launcher.id).toBe(SLICC_LAUNCHER_HOST_ID);
    expect(launcher.isConnected).toBe(true);
    expect(launcher.appUrl).toBe('https://example.test/app');
    expect(launcher.open).toBe(true);
    expect(launcher.corner).toBe('bottom-left');
  });

  it('normalizes an invalid corner to the default and reuses an existing host', () => {
    const first = injectSliccLauncher(document, { corner: 'nonsense' });
    expect(first.corner).toBe(DEFAULT_LAUNCHER_CORNER);
    const second = injectSliccLauncher(document);
    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${SLICC_LAUNCHER_HOST_ID}`).length).toBe(1);
  });

  it('removeSliccLauncher tears the overlay host down', () => {
    injectSliccLauncher(document, { open: true });
    expect(document.getElementById(SLICC_LAUNCHER_HOST_ID)).not.toBeNull();
    removeSliccLauncher(document);
    expect(document.getElementById(SLICC_LAUNCHER_HOST_ID)).toBeNull();
  });
});
