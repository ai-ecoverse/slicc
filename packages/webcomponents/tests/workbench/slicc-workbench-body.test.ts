import { beforeEach, describe, expect, it } from 'vitest';
// Sibling composed by tag (same wave); imported so <slicc-surface> is registered
// at test time. The host composes it strictly by tag — this import only ensures
// the element upgrades so its own [active] styling participates.
import '../../src/workbench/slicc-surface.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';
import { SliccWorkbenchBody } from '../../src/workbench/slicc-workbench-body.js';

/**
 * Build a `<slicc-surface>` addressable by `surface-id` (the sibling's canonical
 * identity, which it mirrors to `data-s` once connected).
 */
function surface(id: string, label = id): HTMLElement {
  const s = document.createElement('slicc-surface');
  s.setAttribute('surface-id', id);
  s.textContent = label;
  return s;
}

/**
 * Mount a workbench body populated with surfaces. `setup` runs before append so
 * initial attributes are set while disconnected (the realistic authoring order).
 */
function mount(
  ids: string[] = ['files', 'term', 'memory'],
  setup?: (el: SliccWorkbenchBody) => void
): SliccWorkbenchBody {
  const el = document.createElement('slicc-workbench-body') as SliccWorkbenchBody;
  // Give the body a definite box so absolute surfaces can fill it.
  el.style.height = '300px';
  el.style.width = '400px';
  for (const id of ids) el.appendChild(surface(id));
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The single child carrying the active host class, or null. */
function activeChild(el: SliccWorkbenchBody): HTMLElement | null {
  return el.querySelector(':scope > .slicc-wbbody__active');
}

/** Resolve a surface's identity the way the host does: surface-id → data-s → id. */
function sid(s: Element): string {
  return s.getAttribute('surface-id') || s.getAttribute('data-s') || s.id;
}

describe('slicc-workbench-body', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-workbench-body')).toBe(SliccWorkbenchBody);
  });

  it('is a light-DOM host (no shadow root)', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
  });

  it('hosts <slicc-surface> children directly, in DOM order', () => {
    const el = mount(['a', 'b', 'c']);
    const kids = el.surfaces;
    expect(kids).toHaveLength(3);
    expect(kids.map(sid)).toEqual(['a', 'b', 'c']);
    // Surfaces remain direct children — the body relocates nothing.
    expect(el.querySelectorAll(':scope > slicc-surface')).toHaveLength(3);
  });

  it('ignores non-surface children when collecting surfaces', () => {
    const el = document.createElement('slicc-workbench-body') as SliccWorkbenchBody;
    el.appendChild(surface('files'));
    const noise = document.createElement('div');
    noise.id = 'noise';
    el.appendChild(noise);
    document.body.appendChild(el);
    expect(el.surfaces).toHaveLength(1);
    expect(sid(el.surfaces[0])).toBe('files');
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects active', () => {
      const el = mount();
      expect(el.active).toBeNull();
      el.active = 'term';
      expect(el.getAttribute('active')).toBe('term');
      expect(el.active).toBe('term');
      el.active = null;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('setting the active attribute selects that surface', () => {
      const el = mount();
      el.setAttribute('active', 'memory');
      const on = activeChild(el);
      expect(on && sid(on)).toBe('memory');
      expect(el.activeSurface && sid(el.activeSurface)).toBe('memory');
    });
  });

  describe('variants / states — default (one child surface active)', () => {
    it('with no active attribute, no surface is shown', () => {
      const el = mount();
      expect(activeChild(el)).toBeNull();
      expect(el.activeSurface).toBeNull();
    });

    it('shows exactly the active surface (mutually exclusive)', () => {
      const el = mount(['files', 'term', 'memory'], (e) => {
        e.active = 'term';
      });
      const on = el.querySelectorAll(':scope > .slicc-wbbody__active');
      expect(on).toHaveLength(1);
      expect(sid(on[0])).toBe('term');
    });

    it('mirrors the active attribute onto the active surface element', () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      const files = el.surfaces.find((s) => sid(s) === 'files') as HTMLElement;
      const term = el.surfaces.find((s) => sid(s) === 'term') as HTMLElement;
      expect(files.hasAttribute('active')).toBe(true);
      expect(term.hasAttribute('active')).toBe(false);
    });
  });

  describe('layout (real Chromium getComputedStyle)', () => {
    it('the body is a flex:1, min-height:0 positioning context', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.position).toBe('relative');
      expect(cs.minHeight).toBe('0px');
      // flex: 1 → grow 1, shrink 1, basis 0%.
      expect(cs.flexGrow).toBe('1');
      expect(cs.flexShrink).toBe('1');
    });

    it('inactive surfaces are display:none', () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      const term = el.surfaces.find((s) => sid(s) === 'term') as HTMLElement;
      expect(getComputedStyle(term).display).toBe('none');
    });

    it('the active surface is shown and absolutely fills the body (inset:0)', () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      const files = el.surfaces.find((s) => sid(s) === 'files') as HTMLElement;
      const cs = getComputedStyle(files);
      expect(cs.display).not.toBe('none');
      expect(cs.position).toBe('absolute');
      // inset:0 → the surface fills the 400×300 body.
      const bodyRect = el.getBoundingClientRect();
      const surfRect = files.getBoundingClientRect();
      expect(Math.round(surfRect.width)).toBe(Math.round(bodyRect.width));
      expect(Math.round(surfRect.height)).toBe(Math.round(bodyRect.height));
    });
  });

  describe('behavior / events', () => {
    it('selectSurface(id) toggles the active surface and reflects active', () => {
      const el = mount(['files', 'term', 'memory'], (e) => {
        e.active = 'files';
      });
      el.selectSurface('memory');
      expect(el.active).toBe('memory');
      const on = activeChild(el);
      expect(on && sid(on)).toBe('memory');
      // Only one active at a time.
      expect(el.querySelectorAll(':scope > .slicc-wbbody__active')).toHaveLength(1);
    });

    it('selectSurface re-stamps active attributes across all surfaces', () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      el.selectSurface('term');
      const files = el.surfaces.find((s) => sid(s) === 'files') as HTMLElement;
      const term = el.surfaces.find((s) => sid(s) === 'term') as HTMLElement;
      expect(files.hasAttribute('active')).toBe(false);
      expect(term.hasAttribute('active')).toBe(true);
    });

    it('selectSurface to the current surface is a no-op (no event)', () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      let fired = 0;
      el.addEventListener('slicc-surface-change', () => {
        fired += 1;
      });
      el.selectSurface('files');
      expect(fired).toBe(0);
    });

    it('emits slicc-surface-change with id + previous (composed + bubbling)', async () => {
      const el = mount(['files', 'term'], (e) => {
        e.active = 'files';
      });
      const detail = await new Promise<{ id: string; previous: string | null }>((resolve) => {
        document.addEventListener(
          'slicc-surface-change',
          (e) => resolve((e as CustomEvent).detail),
          { once: true }
        );
        el.selectSurface('term');
      });
      expect(detail.id).toBe('term');
      expect(detail.previous).toBe('files');
    });

    it('works while disconnected, then survives re-connect', () => {
      const el = mount(['files', 'term']);
      el.remove();
      el.selectSurface('term');
      expect(el.active).toBe('term');
      // Sync ran while disconnected.
      const term = el.surfaces.find((s) => sid(s) === 'term') as HTMLElement;
      expect(term.classList.contains('slicc-wbbody__active')).toBe(true);
      document.body.appendChild(el);
      // Re-connect re-syncs without double-activating.
      expect(el.querySelectorAll(':scope > .slicc-wbbody__active')).toHaveLength(1);
      const on = activeChild(el);
      expect(on && sid(on)).toBe('term');
    });

    it('matches surfaces by data-s (the prototype surface key)', () => {
      // The sibling mirrors `surface-id` → `data-s`; here we drive identity via
      // `surface-id` so `data-s` is what the host resolves against post-connect.
      const el = mount(['browser', 'palette'], (e) => {
        e.active = 'palette';
      });
      const browser = el.surfaces.find((s) => sid(s) === 'browser') as HTMLElement;
      const palette = el.surfaces.find((s) => sid(s) === 'palette') as HTMLElement;
      // Sibling reflected surface-id onto data-s on connect.
      expect(palette.getAttribute('data-s')).toBe('palette');
      expect(palette.classList.contains('slicc-wbbody__active')).toBe(true);
      expect(browser.classList.contains('slicc-wbbody__active')).toBe(false);
    });

    it('falls back to a plain id when no surface-id/data-s is present', () => {
      const el = document.createElement('slicc-workbench-body') as SliccWorkbenchBody;
      const a = document.createElement('slicc-surface');
      a.id = 'alpha';
      const b = document.createElement('slicc-surface');
      b.id = 'beta';
      el.append(a, b);
      document.body.appendChild(el);
      el.selectSurface('beta');
      expect(b.classList.contains('slicc-wbbody__active')).toBe(true);
      expect(a.classList.contains('slicc-wbbody__active')).toBe(false);
    });
  });
});
