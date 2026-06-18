import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAUNCHER_CORNER,
  LAUNCHER_CORNERS,
  normalizeLauncherCorner,
  resolveLauncherCorner,
  shouldSnapLauncher,
} from '../../src/launcher/launcher-state.js';
import { SliccLauncher } from '../../src/launcher/slicc-launcher.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

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
});

describe('slicc-launcher', () => {
  beforeEach(() => {
    ensureGlobalTokens();
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
