import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccFrostShader } from '../../src/freezer/slicc-frost-shader.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** Mount a sized frost element so the canvas has a backing-store size. */
function mount(attrs: Record<string, string> = {}): SliccFrostShader {
  const el = document.createElement('slicc-frost-shader');
  el.style.cssText = 'position:relative;display:block;width:200px;height:120px;';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as SliccFrostShader;
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

describe('slicc-frost-shader', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers and renders a shadow canvas + fallback layer', () => {
    expect(customElements.get('slicc-frost-shader')).toBe(SliccFrostShader);
    const el = mount();
    expect(el.shadowRoot?.querySelector('canvas[part="canvas"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="fallback"]')).not.toBeNull();
  });

  it('defaults coverage to 0.66 and clamps to 0..1', () => {
    const el = mount();
    expect(el.coverage).toBeCloseTo(0.66, 5);
    el.coverage = 2;
    expect(el.coverage).toBe(1);
    el.coverage = -1;
    expect(el.coverage).toBe(0);
    el.setAttribute('coverage', '0.4');
    expect(el.coverage).toBeCloseTo(0.4, 5);
  });

  it('reflects intensity and clamps it', () => {
    const el = mount();
    expect(el.intensity).toBe(1);
    el.intensity = 9;
    expect(el.intensity).toBe(4);
    expect(el.getAttribute('intensity')).toBe('9');
  });

  it('either runs WebGL (no fallback, sized canvas) or degrades to the CSS fallback', async () => {
    const el = mount();
    await frame();
    await frame();
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    if (el.noWebgl) {
      // No WebGL in this environment — the CSS gradient fallback is shown.
      expect(el.hasAttribute('no-webgl')).toBe(true);
      expect(getComputedStyle(canvas).display).toBe('none');
    } else {
      // WebGL available — the canvas backing store is sized to the host.
      expect(el.hasAttribute('no-webgl')).toBe(false);
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
    }
  });

  it('pointer-events are disabled so it never intercepts clicks', () => {
    const el = mount();
    expect(getComputedStyle(el.shadowRoot?.querySelector('canvas') as Element).pointerEvents).toBe(
      'none'
    );
  });

  it('stops cleanly on disconnect without throwing', async () => {
    const el = mount();
    await frame();
    expect(() => el.remove()).not.toThrow();
  });
});
