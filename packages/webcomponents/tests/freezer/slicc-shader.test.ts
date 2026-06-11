import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccShader } from '../../src/freezer/slicc-shader.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccShader {
  const el = document.createElement('slicc-shader');
  el.style.cssText = 'position:relative;display:block;width:240px;height:160px;';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as SliccShader;
}
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe('slicc-shader', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers and renders a shadow canvas + fallback', () => {
    expect(customElements.get('slicc-shader')).toBe(SliccShader);
    const el = mount();
    expect(el.shadowRoot?.querySelector('canvas[part="canvas"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="fallback"]')).not.toBeNull();
  });

  it('defaults to cone mode and accepts cone/scoop/freezer', () => {
    expect(mount().mode).toBe('cone');
    expect(mount({ mode: 'scoop' }).mode).toBe('scoop');
    expect(mount({ mode: 'freezer' }).mode).toBe('freezer');
    // unknown mode normalizes to cone
    expect(mount({ mode: 'bogus' }).mode).toBe('cone');
  });

  it('links each program (or degrades to the CSS fallback)', async () => {
    for (const mode of ['cone', 'scoop', 'freezer'] as const) {
      const el = mount({ mode });
      await frame();
      await frame();
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      if (el.noWebgl) {
        expect(getComputedStyle(canvas).display).toBe('none');
      } else {
        expect(canvas.width).toBeGreaterThan(0);
      }
      el.remove();
    }
  });

  it('recompiles when the mode changes at runtime without throwing', async () => {
    const el = mount({ mode: 'cone' });
    await frame();
    expect(() => {
      el.mode = 'scoop';
      el.mode = 'freezer';
    }).not.toThrow();
  });

  it('reflects coverage/intensity and exposes pulse()', () => {
    const el = mount({ mode: 'freezer' });
    expect(el.coverage).toBeCloseTo(0.66, 5);
    el.coverage = 0.9;
    expect(el.getAttribute('coverage')).toBe('0.9');
    expect(el.intensity).toBe(1);
    expect(() => el.pulse()).not.toThrow();
  });

  it('keeps the canvas pointer-transparent and disposes cleanly', async () => {
    const el = mount({ mode: 'scoop' });
    expect(getComputedStyle(el.shadowRoot?.querySelector('canvas') as Element).pointerEvents).toBe(
      'none'
    );
    await frame();
    expect(() => el.remove()).not.toThrow();
  });
});

describe('slicc-shader scroll (field pans with the chat)', () => {
  it('reflects the scroll attribute to the scrollOffset property (px, default 0)', () => {
    const el = document.createElement('slicc-shader');
    document.body.appendChild(el);
    expect(el.scrollOffset).toBe(0);
    el.scrollOffset = 420;
    expect(el.getAttribute('scroll')).toBe('420');
    el.setAttribute('scroll', 'bogus');
    expect(el.scrollOffset).toBe(0);
    el.remove();
  });

  it('keeps rendering with a live scroll offset (no GL errors)', async () => {
    const el = document.createElement('slicc-shader');
    el.style.cssText = 'position:fixed;inset:0;';
    document.body.appendChild(el);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    el.setAttribute('scroll', '300');
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // Still alive: either the GL canvas or the no-webgl CSS fallback.
    expect(el.shadowRoot?.querySelector('canvas') !== null || el.hasAttribute('no-webgl')).toBe(
      true
    );
    el.remove();
  });
});
