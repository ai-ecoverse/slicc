import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { SliccSurface } from '../../src/workbench/slicc-surface.js';

/**
 * Mount a surface inside a positioned `.wbbody`-style frame so the `inset:0`
 * geometry resolves and `getComputedStyle` reflects the real reveal display.
 */
function mount(setup?: (el: SliccSurface) => void): SliccSurface {
  const body = document.createElement('div');
  body.style.cssText = 'position:relative;width:600px;height:400px;';
  const el = document.createElement('slicc-surface') as SliccSurface;
  setup?.(el);
  body.appendChild(el);
  document.body.appendChild(body);
  return el;
}

describe('slicc-surface', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-surface')).toBe(SliccSurface);
  });

  it('renders into light DOM (no shadow root)', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
  });

  it('slots arbitrary content unchanged in DOM order', () => {
    const el = mount((e) => {
      e.innerHTML = '<div class="tree"></div><div class="fileview"></div>';
    });
    const tree = el.querySelector('.tree');
    const view = el.querySelector('.fileview');
    expect(tree).not.toBeNull();
    expect(view).not.toBeNull();
    expect(tree!.compareDocumentPosition(view!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects surface-id and mirrors it onto data-s', () => {
      const el = mount((e) => {
        e.surfaceId = 'memory';
      });
      expect(el.getAttribute('surface-id')).toBe('memory');
      expect(el.surfaceId).toBe('memory');
      expect(el.dataset.s).toBe('memory');

      el.surfaceId = 'browser';
      expect(el.dataset.s).toBe('browser');

      el.surfaceId = null;
      expect(el.hasAttribute('surface-id')).toBe(false);
      expect(el.dataset.s).toBeUndefined();
    });

    it('reflects active', () => {
      const el = mount();
      expect(el.active).toBe(false);
      el.active = true;
      expect(el.hasAttribute('active')).toBe(true);
      expect(el.active).toBe(true);
      el.active = false;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('reflects layout (default flex; only flex|block|column accepted)', () => {
      const el = mount();
      expect(el.layout).toBe('flex');
      el.layout = 'block';
      expect(el.getAttribute('layout')).toBe('block');
      expect(el.layout).toBe('block');
      el.layout = 'column';
      expect(el.layout).toBe('column');
      // Anything else normalizes back to flex.
      el.setAttribute('layout', 'bogus');
      expect(el.layout).toBe('flex');
    });
  });

  describe('visibility / variant display (real Chromium getComputedStyle)', () => {
    it('is hidden (display:none) when inactive', () => {
      const el = mount();
      expect(getComputedStyle(el).display).toBe('none');
    });

    it('reveals as flex when active with the default layout', () => {
      const el = mount((e) => {
        e.active = true;
      });
      expect(getComputedStyle(el).display).toBe('flex');
    });

    it('reveals as flex when active with layout="flex"', () => {
      const el = mount((e) => {
        e.active = true;
        e.layout = 'flex';
      });
      expect(getComputedStyle(el).display).toBe('flex');
    });

    it('reveals as block when active with layout="block" (mem/pal)', () => {
      const el = mount((e) => {
        e.active = true;
        e.layout = 'block';
      });
      expect(getComputedStyle(el).display).toBe('block');
    });

    it('reveals as a column flex with #fafafa backdrop when active with layout="column" (browser)', () => {
      const el = mount((e) => {
        e.active = true;
        e.layout = 'column';
      });
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('flex');
      expect(cs.flexDirection).toBe('column');
      // #fafafa → rgb(250, 250, 250).
      expect(cs.backgroundColor).toBe('rgb(250, 250, 250)');
    });

    it('does not paint the #fafafa backdrop when the column surface is inactive', () => {
      const el = mount((e) => {
        e.layout = 'column';
      });
      expect(getComputedStyle(el).display).toBe('none');
    });

    it('fills its positioned parent (position:absolute; inset:0)', () => {
      const el = mount((e) => {
        e.active = true;
      });
      const cs = getComputedStyle(el);
      expect(cs.position).toBe('absolute');
      const rect = el.getBoundingClientRect();
      // The mount frame is 600x400; an inset:0 absolute fill matches it.
      expect(rect.width).toBeCloseTo(600, 0);
      expect(rect.height).toBeCloseTo(400, 0);
    });
  });

  describe('exclusive stacking', () => {
    it('keeps inactive siblings hidden while the active one shows', () => {
      const frame = document.createElement('div');
      frame.style.cssText = 'position:relative;width:600px;height:400px;';
      const files = document.createElement('slicc-surface') as SliccSurface;
      files.surfaceId = 'files';
      const memory = document.createElement('slicc-surface') as SliccSurface;
      memory.surfaceId = 'memory';
      memory.active = true;
      memory.layout = 'block';
      frame.append(files, memory);
      document.body.appendChild(frame);

      expect(getComputedStyle(files).display).toBe('none');
      expect(getComputedStyle(memory).display).toBe('block');
    });
  });

  describe('surface-toggle event', () => {
    it('fires a composed, bubbling event with detail when active turns on', () => {
      const el = mount((e) => {
        e.surfaceId = 'term';
      });
      const onToggle = vi.fn();
      el.addEventListener('surface-toggle', onToggle);
      el.active = true;

      expect(onToggle).toHaveBeenCalledTimes(1);
      const ev = onToggle.mock.calls[0][0] as CustomEvent;
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
      expect(ev.detail).toEqual({ surfaceId: 'term', active: true, layout: 'flex' });
    });

    it('fires again when active turns off (detail reflects the new state)', () => {
      const el = mount((e) => {
        e.surfaceId = 'term';
        e.active = true;
      });
      const onToggle = vi.fn();
      el.addEventListener('surface-toggle', onToggle);
      el.active = false;

      expect(onToggle).toHaveBeenCalledTimes(1);
      const ev = onToggle.mock.calls[0][0] as CustomEvent;
      expect(ev.detail.active).toBe(false);
    });

    it('does not fire when active is set to its current value', () => {
      const el = mount((e) => {
        e.active = true;
      });
      const onToggle = vi.fn();
      el.addEventListener('surface-toggle', onToggle);
      // Re-asserting the attribute to the same value is a no-op (prev === next).
      el.setAttribute('active', '');
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('bubbles out to the workbench body', () => {
      const frame = document.createElement('div');
      frame.style.cssText = 'position:relative;width:600px;height:400px;';
      const el = document.createElement('slicc-surface') as SliccSurface;
      el.surfaceId = 'files';
      frame.appendChild(el);
      document.body.appendChild(frame);

      const onFrame = vi.fn();
      frame.addEventListener('surface-toggle', onFrame);
      el.active = true;
      expect(onFrame).toHaveBeenCalledTimes(1);
    });
  });

  describe('theme', () => {
    it('terminal surface content stays dark regardless of page theme', () => {
      // The dark canvas comes from the slotted `.term`, not the container; the
      // container itself is theme-neutral (transparent) in both modes.
      const el = mount((e) => {
        e.surfaceId = 'term';
        e.active = true;
        e.innerHTML = '<div class="term" style="background:#0c0c0e;">$</div>';
      });
      const term = el.querySelector('.term') as HTMLElement;
      const light = getComputedStyle(term).backgroundColor;
      setTheme('dark');
      const dark = getComputedStyle(term).backgroundColor;
      // #0c0c0e → rgb(12, 12, 14), unchanged across themes.
      expect(light).toBe('rgb(12, 12, 14)');
      expect(dark).toBe('rgb(12, 12, 14)');
    });
  });
});
