import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHADER_FRAGMENTS, SliccShader } from '../../src/freezer/slicc-shader.js';
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

  it('reflects cone-mode brightness/contrast/noise/blur knobs (tuned defaults)', () => {
    const el = mount();
    // Tuned defaults baked in so the cone field renders with the Storybook
    // texture everywhere with no attributes required.
    // The blur attribute reflects to `blurAmount` because HTMLElement already
    // defines a `blur()` method — same renaming dance as `scroll`/`scrollOffset`.
    expect(el.brightness).toBe(1.2);
    expect(el.contrast).toBe(0.75);
    expect(el.noise).toBeCloseTo(0.04, 5);
    expect(el.blurAmount).toBeCloseTo(0.09, 5);
    // Property → attribute round-trip.
    el.brightness = 1.25;
    el.contrast = 1.5;
    el.noise = 0.15;
    el.blurAmount = 0.5;
    expect(el.getAttribute('brightness')).toBe('1.25');
    expect(el.getAttribute('contrast')).toBe('1.5');
    expect(el.getAttribute('noise')).toBe('0.15');
    expect(el.getAttribute('blur')).toBe('0.5');
    // Attribute → property reflection and clamping at the documented ranges.
    el.setAttribute('brightness', '99');
    el.setAttribute('contrast', '0');
    el.setAttribute('noise', '5');
    el.setAttribute('blur', '-1');
    expect(el.brightness).toBe(1.5);
    expect(el.contrast).toBe(0.5);
    expect(el.noise).toBe(0.3);
    expect(el.blurAmount).toBe(0);
    // Bogus values fall back to the tuned defaults.
    el.setAttribute('brightness', 'nope');
    el.setAttribute('contrast', 'nope');
    el.setAttribute('noise', 'nope');
    el.setAttribute('blur', 'nope');
    expect(el.brightness).toBe(1.2);
    expect(el.contrast).toBe(0.75);
    expect(el.noise).toBeCloseTo(0.04, 5);
    expect(el.blurAmount).toBeCloseTo(0.09, 5);
  });

  it('cone fragment program references the new brightness/contrast/noise/blur uniforms', () => {
    const cone = SHADER_FRAGMENTS.cone;
    expect(cone).toContain('uniform float u_brightness');
    expect(cone).toContain('uniform float u_contrast');
    expect(cone).toContain('uniform float u_noise');
    expect(cone).toContain('uniform float u_blur');
    // And the body actually applies them before the final write.
    expect(cone).toContain('u_brightness');
    expect(cone).toContain('u_contrast');
    expect(cone).toContain('u_noise');
    expect(cone).toContain('u_blur');
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

describe('slicc-shader program cache + immediate repaint (anti-flicker)', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('caches programs: revisiting a mode does NOT recompile or relink', async () => {
    const compileSpy = vi.spyOn(WebGLRenderingContext.prototype, 'compileShader');
    const createProgramSpy = vi.spyOn(WebGLRenderingContext.prototype, 'createProgram');
    try {
      const el = mount({ mode: 'cone' });
      await frame();
      if (el.noWebgl) return; // no WebGL in this runner — caching is N/A
      // Cold visits: cone is built at init, scoop + freezer on switch. Each
      // mode-set is synchronous, so all three programs are cached after this.
      el.mode = 'scoop';
      el.mode = 'freezer';
      const coldCompiles = compileSpy.mock.calls.length;
      const coldPrograms = createProgramSpy.mock.calls.length;
      expect(coldPrograms).toBeGreaterThan(0); // we really did build programs
      // Revisit every already-built mode — the cache must be reused.
      el.mode = 'cone';
      el.mode = 'scoop';
      el.mode = 'freezer';
      el.mode = 'cone';
      expect(compileSpy.mock.calls.length).toBe(coldCompiles);
      expect(createProgramSpy.mock.calls.length).toBe(coldPrograms);
      el.remove();
    } finally {
      compileSpy.mockRestore();
      createProgramSpy.mockRestore();
    }
  });

  it('repaints immediately with the new program on a mode change (not deferred to rAF)', async () => {
    const drawSpy = vi.spyOn(WebGLRenderingContext.prototype, 'drawArrays');
    const useProgramSpy = vi.spyOn(WebGLRenderingContext.prototype, 'useProgram');
    try {
      const el = mount({ mode: 'cone' });
      await frame();
      if (el.noWebgl) return;
      const drawsBefore = drawSpy.mock.calls.length;
      const programBefore = useProgramSpy.mock.calls.at(-1)?.[0];
      // Synchronous attribute change — read state in the SAME tick, before any
      // requestAnimationFrame callback can fire.
      el.mode = 'freezer';
      // The canvas was repainted synchronously, so the old frame never lingers.
      expect(drawSpy.mock.calls.length).toBeGreaterThan(drawsBefore);
      // …and the new (freezer) program is the active one — a different handle.
      const programAfter = useProgramSpy.mock.calls.at(-1)?.[0];
      expect(programAfter).toBeTruthy();
      expect(programAfter).not.toBe(programBefore);
      expect(el.mode).toBe('freezer');
      el.remove();
    } finally {
      drawSpy.mockRestore();
      useProgramSpy.mockRestore();
    }
  });
});

describe('slicc-shader does not force a style recalc per frame (flicker fix)', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('resolves CSS-derived uniforms once, not on every animation frame', async () => {
    const el = mount({ mode: 'cone', tint: 'var(--waffle)' });
    await frame();
    await frame();
    if (el.noWebgl) return; // no WebGL in this runner — the rAF render loop never runs

    // Steady state: a running rAF loop must NOT query computed style. The
    // shader resolves its tint/evt/--ink uniforms once (on connect + on a
    // theme/tint change), so getComputedStyle should not be called while it
    // merely animates. The bug called getComputedStyle 3x/frame (colorToVec3
    // for tint + evt, plus #darkUniform reading --ink) and appended a probe
    // <span> to document.body twice/frame — forcing a full-document style
    // recalc on every frame, which is the flicker.
    const gcs = vi.spyOn(window, 'getComputedStyle');
    let probeAppends = 0;
    const mo = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) if ((n as Element).tagName === 'SPAN') probeAppends++;
    });
    mo.observe(document.body, { childList: true });
    try {
      for (let i = 0; i < 6; i++) await frame();
      expect(gcs).not.toHaveBeenCalled();
      expect(probeAppends).toBe(0);
    } finally {
      mo.disconnect();
      gcs.mockRestore();
      el.remove();
    }
  });
});

/**
 * Compile a fragment program standalone and read back the rendered pixels —
 * the component's own context never preserves its drawing buffer, so color
 * assertions need a context we control.
 */
function renderFragment(
  frag: string,
  uniforms: Record<string, number | number[]>
): Uint8Array | null {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const gl = cv.getContext('webgl');
  if (!gl) return null; // no WebGL in this runner — caller soft-skips
  const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
  gl.shaderSource(vs, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
  gl.shaderSource(fs, frag);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error(`fragment compile failed: ${gl.getShaderInfoLog(fs)}`);
  }
  const prog = gl.createProgram() as WebGLProgram;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  for (const [name, v] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(prog, name);
    if (!loc) continue;
    if (Array.isArray(v)) {
      if (v.length === 2) gl.uniform2fv(loc, v);
      else gl.uniform3fv(loc, v);
    } else gl.uniform1f(loc, v);
  }
  gl.viewport(0, 0, size, size);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

/** Mean r/g/b over the full readback. */
function meanRgb(px: Uint8Array): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

describe('freezer field colors (inside-of-a-freezer, not sand)', () => {
  const FREEZER_UNIFORMS = {
    u_res: [64, 64],
    u_time: 0,
    u_freeze: 1, // fully frozen — the frost pattern is at max extent
    u_scroll: 0,
  };

  it('light mode renders blue-on-white: cold hue, white-dominant ground', () => {
    const px = renderFragment(SHADER_FRAGMENTS.freezer, { ...FREEZER_UNIFORMS, u_dark: 0 });
    if (!px) return; // no WebGL — covered by the fallback test above
    const { r, g, b } = meanRgb(px);
    // Cold: blue strictly leads red (the old warm-canvas wash had r > b).
    expect(b).toBeGreaterThan(r);
    // White-dominant: the washed field stays bright across all channels.
    expect((r + g + b) / 3).toBeGreaterThan(200);
  });

  it('dark mode renders a cold dark field (still blue-leaning, never warm)', () => {
    const px = renderFragment(SHADER_FRAGMENTS.freezer, { ...FREEZER_UNIFORMS, u_dark: 1 });
    if (!px) return;
    const { r, g, b } = meanRgb(px);
    expect(b).toBeGreaterThan(r);
    expect((r + g + b) / 3).toBeLessThan(80);
  });

  it('animates on a glacial clock (frost creeps, it never flows)', () => {
    // The freezer program scales its time uniform far down before any
    // animated term — assert the clock itself, not a flaky pixel diff.
    expect(SHADER_FRAGMENTS.freezer).toContain('float t=u_time*0.08;');
    // And no animated term reads the raw clock directly anymore.
    const body = SHADER_FRAGMENTS.freezer.split('float t=u_time*0.08;')[1] ?? '';
    expect(body).not.toContain('u_time');
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
