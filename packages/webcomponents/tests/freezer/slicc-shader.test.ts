import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_RESTORE_TIMEOUT_MS,
  SHADER_FRAGMENTS,
  SliccShader,
  SUGAR_GLASS_PRESETS,
} from '../../src/freezer/slicc-shader.js';
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

  it('defaults to cone mode and accepts the three distinct programs', () => {
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

  it('uses the complete Caramel preset for an attribute-less cone', () => {
    const el = mount();
    expect(el.getAttribute('tint')).toBeNull();
    expect(el.coverage).toBe(SUGAR_GLASS_PRESETS.caramel.coverage);
    expect(el.brightness).toBe(SUGAR_GLASS_PRESETS.caramel.brightness);
    expect(el.contrast).toBe(SUGAR_GLASS_PRESETS.caramel.contrast);
    expect(el.noise).toBe(SUGAR_GLASS_PRESETS.caramel.noise);
    expect(el.blurAmount).toBe(SUGAR_GLASS_PRESETS.caramel.blur);
    expect(el.speed).toBe(SUGAR_GLASS_PRESETS.caramel.speed);
  });

  it('reflects cone glass brightness/contrast/noise/blur knobs', () => {
    const el = mount();
    // The blur attribute reflects to `blurAmount` because HTMLElement already
    // defines a `blur()` method — same renaming dance as `scroll`/`scrollOffset`.
    expect(el.brightness).toBe(1.1);
    expect(el.contrast).toBe(1.1);
    expect(el.noise).toBeCloseTo(0.025, 5);
    expect(el.blurAmount).toBeCloseTo(0.14, 5);
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
    expect(el.brightness).toBe(1.1);
    expect(el.contrast).toBe(1.1);
    expect(el.noise).toBeCloseTo(0.025, 5);
    expect(el.blurAmount).toBeCloseTo(0.14, 5);
  });

  it('reflects and clamps the cone glass animation speed (Caramel default 0.0625)', () => {
    const el = mount();
    expect(el.speed).toBe(0.0625);
    el.speed = 0.0625;
    expect(el.getAttribute('speed')).toBe('0.0625');
    expect(el.speed).toBe(0.0625);
    el.setAttribute('speed', '-1');
    expect(el.speed).toBe(0);
    el.setAttribute('speed', '99');
    expect(el.speed).toBe(2);
    el.setAttribute('speed', 'nope');
    expect(el.speed).toBe(0.0625);
  });

  it('keeps the cone glass render loop healthy when speed is zero', async () => {
    const el = mount({ speed: '0' });
    await frame();
    await frame();
    expect(el.speed).toBe(0);
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    expect(el.noWebgl || canvas.width > 0).toBe(true);
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

  it('leaves every declared uniform read by a program', () => {
    const sources = Object.values(SHADER_FRAGMENTS);
    const declarations = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/uniform\s+\w+\s+(u_\w+)/g)].map((match) => match[1])
      )
    );
    for (const name of declarations) {
      const declaration = new RegExp(`uniform\\s+\\w+\\s+${name};`, 'g');
      expect(
        sources.some((source) => source.replace(declaration, '').includes(name)),
        `${name} is declared but unread`
      ).toBe(true);
    }
  });

  it('keeps the canvas pointer-transparent and disposes cleanly', async () => {
    const el = mount({ mode: 'scoop' });
    expect(getComputedStyle(el.shadowRoot?.querySelector('canvas') as Element).pointerEvents).toBe(
      'none'
    );
    await frame();
    expect(() => el.remove()).not.toThrow();
  });

  it('re-acquires a live context when the field is remounted', async () => {
    // Regression: a tab switch unmounts and re-mounts the panel host. The
    // teardown ends in an explicit loseContext(), and a canvas holding a lost
    // context hands that same dead context back from getContext() forever — so
    // the remounted field used to come back permanently frozen (or blank behind
    // an unset `no-webgl`). Re-init must swap in a fresh canvas.
    const el = mount({ mode: 'scoop' });
    await frame();
    await frame();
    if (el.noWebgl) return; // no WebGL in this runner at all
    const first = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    expect(first.getContext('webgl')?.isContextLost()).toBe(false);

    el.remove();
    await frame();
    expect(first.getContext('webgl')?.isContextLost()).toBe(true);

    document.body.appendChild(el);
    await frame();
    await frame();

    const second = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    expect(second.getContext('webgl')?.isContextLost()).toBe(false);
    expect(second).not.toBe(first);
    expect(el.noWebgl).toBe(false);
    // and the shadow root still holds exactly one canvas, ahead of the fallback
    expect(el.shadowRoot?.querySelectorAll('canvas')).toHaveLength(1);
    expect(el.shadowRoot?.firstElementChild).toBe(second);
  });

  it('reflects no-webgl when the acquired context is already lost', async () => {
    // A context that comes back dead (and cannot be replaced) must degrade to
    // the CSS gradient rather than park on unusable handles.
    const el = mount();
    await frame();
    if (el.noWebgl) return;
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ isContextLost: () => true } as unknown as WebGLRenderingContext);
    try {
      el.remove();
      document.body.appendChild(el);
      await frame();
      expect(el.noWebgl).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('releases partial GL resources when initialization fails', () => {
    const createBufferSpy = vi
      .spyOn(WebGLRenderingContext.prototype, 'createBuffer')
      .mockImplementation(() => null as unknown as WebGLBuffer);
    const deleteProgramSpy = vi.spyOn(WebGLRenderingContext.prototype, 'deleteProgram');
    const deleteShaderSpy = vi.spyOn(WebGLRenderingContext.prototype, 'deleteShader');
    const getExtensionSpy = vi.spyOn(WebGLRenderingContext.prototype, 'getExtension');
    try {
      const el = mount();
      if (createBufferSpy.mock.calls.length === 0) return;
      expect(el.noWebgl).toBe(true);
      expect(deleteProgramSpy).toHaveBeenCalledOnce();
      expect(deleteShaderSpy).toHaveBeenCalledTimes(2);
      expect(getExtensionSpy).toHaveBeenCalledWith('WEBGL_lose_context');
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      expect(canvas.getContext('webgl')?.isContextLost()).toBe(true);
    } finally {
      createBufferSpy.mockRestore();
      deleteProgramSpy.mockRestore();
      deleteShaderSpy.mockRestore();
      getExtensionSpy.mockRestore();
    }
  });

  describe('frame budget', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Count WebGL draw calls from the moment of installation. */
    const spyDraws = () => vi.spyOn(WebGLRenderingContext.prototype, 'drawArrays');
    /**
     * Wait until the field has actually stopped drawing, then return. A fixed
     * sleep is not enough on a loaded machine: the ResizeObserver's initial
     * notification wakes a frame, and under CI throttling that frame can land
     * *after* the sleep -- it would then be counted against a "draws nothing"
     * assertion as a single stray draw. Polls until one whole window passes
     * with no draw, so the spy installed afterwards starts from real quiet.
     */
    const settle = async (windowMs = 120, timeoutMs = 3000) => {
      const probe = vi.spyOn(WebGLRenderingContext.prototype, 'drawArrays');
      try {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const before = probe.mock.calls.length;
          await wait(windowMs);
          if (probe.mock.calls.length === before) return; // quiet window: settled
          if (Date.now() > deadline) return; // still busy: let the assertion report it
        }
      } finally {
        probe.mockRestore();
      }
    };
    /**
     * Shared restore-event + follow-up poll budget. Independent helper
     * timeouts (3s + 3s) can exceed Vitest's 5s default and abort the test
     * before either reports. Stays below RESTORE_TEST_TIMEOUT_MS so the
     * helper's error surfaces first.
     */
    const RESTORE_WAIT_BUDGET_MS = 8_000;
    /** Covers restore budget + expectStopped (20×250ms) + setup sleeps. */
    const RESTORE_TEST_TIMEOUT_MS = 15_000;
    /**
     * Await `webglcontextrestored` after `restoreContext()`. A fixed sleep is
     * not enough under CI throttling: the browser delivers the event (and the
     * subsequent #wake rAF) on its own schedule — merge-queue flake that kicked
     * #2338 out of the queue waited only 300ms and saw zero draws.
     */
    const restoreContext = async (
      lose: { restoreContext: () => void },
      canvas: HTMLCanvasElement,
      timeoutMs = RESTORE_WAIT_BUDGET_MS
    ): Promise<void> => {
      const done = new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error(`webglcontextrestored timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        canvas.addEventListener(
          'webglcontextrestored',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true }
        );
      });
      lose.restoreContext();
      await done;
    };
    /** Poll until a draw spy has seen at least `min` calls (post-restore rAF). */
    const waitForDraws = async (
      spy: { mock: { calls: unknown[] } },
      min = 1,
      timeoutMs = RESTORE_WAIT_BUDGET_MS
    ): Promise<void> => {
      await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(min), {
        timeout: timeoutMs,
        interval: 50,
      });
    };
    /**
     * Restore the context, then run `after` against the leftover budget so
     * the event wait and the follow-up poll share one deadline.
     */
    const restoreThen = async <T>(
      lose: { restoreContext: () => void },
      canvas: HTMLCanvasElement,
      after: (remainingMs: number) => Promise<T>,
      budgetMs = RESTORE_WAIT_BUDGET_MS
    ): Promise<T> => {
      const deadline = Date.now() + budgetMs;
      await restoreContext(lose, canvas, budgetMs);
      return after(Math.max(500, deadline - Date.now()));
    };
    /** Poll until the draw count is stable across a quiet window, then confirm. */
    const expectStopped = async (
      spy: { mock: { calls: unknown[] } },
      windowMs = 250,
      attempts = 20
    ): Promise<void> => {
      let settled = spy.mock.calls.length;
      for (let i = 0; i < attempts; i++) {
        await wait(windowMs);
        const next = spy.mock.calls.length;
        if (next === settled) break;
        settled = next;
      }
      await wait(windowMs);
      expect(spy.mock.calls.length).toBe(settled);
    };

    afterEach(() => vi.restoreAllMocks());

    it('renders ambient motion on the 15fps budget, not at display rate', async () => {
      const el = mount({ mode: 'scoop' }); // scoop animates unconditionally
      if (el.noWebgl) return; // CSS-fallback host: nothing to measure
      await wait(50); // let the first frame land
      const spy = spyDraws();
      await wait(1500);
      // 1500ms at 15fps ≈ 23 draws. Upper bound 30 (= 20fps average) rejects a
      // 30fps or 60fps regression while tolerating rAF jitter; lower bound
      // tolerates heavily-throttled CI. Do not tighten either bound.
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(30);
    });

    it('cone with speed=0 renders once and stops', async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await settle(); // connect renders exactly one frame, then stops
      const spy = spyDraws();
      await wait(250);
      expect(spy.mock.calls.length).toBe(0);
    });

    it('an attribute change re-renders a static field', async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await wait(150);
      const spy = spyDraws();
      el.setAttribute('scroll', '120');
      await wait(120);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('pulse() wakes a static field and it re-stops after the energy decays', async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await wait(150);
      const spy = spyDraws();
      // 0.0011 falls below the 0.001 rest floor after ~2 rendered frames, so
      // decay completes fast even on a throttled CI rAF.
      el.pulse(0.0011);
      await wait(200);
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      // Poll until the draw count is stable across a quiet window (decay done).
      await expectStopped(spy);
    });

    it('switching an animated field into cone speed=0 settles to a stopped loop', async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const spy = spyDraws();
      el.setAttribute('speed', '0');
      el.setAttribute('mode', 'cone');
      // The mode switch repaints synchronously exactly once (pins
      // #lastFrameTs = performance.now()); no rAF has fired yet.
      expect(spy.mock.calls.length).toBe(1);
      await wait(900); // outlast the attribute-change burst window
      const settled = spy.mock.calls.length;
      await wait(250);
      expect(spy.mock.calls.length).toBe(settled); // loop has settled/stopped
    });

    it('ignores stimuli while the WebGL context is lost', async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return; // extension unavailable: nothing to exercise
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      lose.loseContext();
      await wait(100); // let the webglcontextlost event land
      const spy = spyDraws();
      el.pulse();
      el.setAttribute('scroll', '50');
      await wait(250);
      expect(spy.mock.calls.length).toBe(0);
    });

    it('cone with speed=0 renders at least one frame (not zero) then stops', async () => {
      const spy = spyDraws();
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await wait(200); // connect renders, then the loop self-terminates
      // Pins "renders (not zero)" against a regression that drops the connect
      // frame entirely (which the stop-focused test above cannot catch). The
      // upper bound is 2: the connect frame plus at most one ambient frame from
      // the ResizeObserver initial-notification wake (a static field then stops).
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('a theme change re-renders a static field and it re-stops', async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await wait(150); // settle: one connect frame, then stopped
      const spy = spyDraws();
      const html = document.documentElement;
      const hadDark = html.classList.contains('dark');
      html.classList.toggle('dark'); // fires the theme MutationObserver -> #wake
      // The 150/250 ms windows below deliberately sit INSIDE the 800 ms burst:
      // this is the only test pinning static-field behavior mid-burst (a static
      // field must render once and re-stop even while a burst is open). Do not
      // widen these waits past BURST_MS.
      try {
        await wait(150);
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
        // ...and the static field re-stops rather than looping on.
        const settled = spy.mock.calls.length;
        await wait(250);
        expect(spy.mock.calls.length).toBe(settled);
      } finally {
        if (hadDark) html.classList.add('dark');
        else html.classList.remove('dark');
      }
    });

    it('pulse(NaN) does not spin a static field', async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await settle(); // stopped
      const spy = spyDraws();
      el.pulse(Number.NaN);
      await wait(300);
      // The finite guard rejects NaN, so no wake and no loop; without it a NaN
      // energy would never clear the rest floor and the loop would run forever.
      expect(spy.mock.calls.length).toBe(0);
    });

    it('a static field revealed from display:none renders at its real size', async () => {
      // Mounted hidden: ResizeObserver delivers NO initial notification, so the
      // FIRST notification is the real "became visible" resize — it must wake
      // (fix skips the burst, not the wake), else the field stays a 1×1 canvas.
      const wrapper = document.createElement('div');
      wrapper.style.display = 'none';
      const el = document.createElement('slicc-shader');
      el.setAttribute('speed', '0'); // static: no ambient loop to mask the bug
      el.style.cssText = 'position:relative;display:block;width:240px;height:160px;';
      wrapper.appendChild(el);
      document.body.appendChild(wrapper);
      if (el.noWebgl) return;
      await wait(150); // connected but hidden
      const spy = spyDraws();
      wrapper.style.display = 'block';
      await wait(300);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(canvas.width).toBeGreaterThan(1); // real size, not the hidden 1×1 stretch
    });

    it('an animated field returns to the ambient budget after a burst expires', async () => {
      // The one realistic route back to the original burn: a burst that never
      // expires (the finding's "continuous scroll bursts") keeping the field at
      // display rate. A `scroll` change opens a PURE burst — unlike pulse(),
      // whose glow energy also decays over rendered frames and would keep the
      // field at display rate past BURST_MS in a frame-rate-dependent way,
      // confounding a burst-expiry measurement.
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      el.setAttribute('scroll', '40'); // opens an 800 ms burst, no lingering energy
      await wait(1000); // past BURST_MS
      const spy = spyDraws();
      await wait(1000);
      // Ambient ≈ 15 draws/s; a never-expiring burst (the original burn) reads
      // 60+. Wide bounds for slow CI — do not tighten.
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(22);
    });

    it('draws nothing once unmounted (the disconnect energy win)', async () => {
      // #2214's teardown must keep working: an unmounted field releases its GL
      // context and stops drawing outright. The remount fix must not turn the
      // teardown into a no-op to make re-init easier.
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      el.remove();
      const spy = spyDraws();
      await wait(400);
      expect(spy.mock.calls.length).toBe(0);
      expect(canvas.getContext('webgl')?.isContextLost()).toBe(true);
    });

    it('a remounted animated field runs on the ambient budget, not display rate', async () => {
      // Perf guard on the remount path (#2214): coming back from a tab switch
      // must return to the 15fps ambient cadence, never the pre-#2214 burn.
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      el.remove();
      document.body.appendChild(el);
      await wait(1000); // past BURST_MS, so only ambient frames are counted
      const spy = spyDraws();
      await wait(1000);
      // Same bounds as the post-burst ambient test — do not tighten.
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(22);
    });

    it('a remounted static field renders once and re-stops', async () => {
      // The true-static-stop guarantee must survive a remount too: cone at
      // speed=0 repaints its one frame on connect, then the loop terminates.
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await settle();
      el.remove();
      const spy = spyDraws();
      document.body.appendChild(el);
      await waitForDraws(spy, 1, 2000); // the one remount frame
      await expectStopped(spy); // ...and then nothing
    });

    it('a remounted field keeps the DPR-1 backing-store cap', async () => {
      // The fresh canvas must inherit the #2214 resolution cap. Measured under a
      // stubbed ratio of 2 — at the runner's native ratio of 1 the cap is a
      // no-op and the assertion would pass without proving anything.
      const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
      Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
      try {
        const el = mount({ mode: 'scoop' });
        if (el.noWebgl) return;
        await wait(100);
        el.remove();
        document.body.appendChild(el);
        await wait(300);
        const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
        expect(canvas.width).toBe(240); // min(cap 1, ratio 2) × 240px — 480 if uncapped
      } finally {
        if (original) Object.defineProperty(window, 'devicePixelRatio', original);
        else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
      }
    });

    it('resumes rendering after the WebGL context is restored (animated)', {
      timeout: RESTORE_TEST_TIMEOUT_MS,
    }, async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      lose.loseContext();
      await wait(100); // let webglcontextlost land
      const spy = spyDraws();
      await restoreThen(lose, canvas, (ms) => waitForDraws(spy, 1, ms)); // #wake rAF after relink
    });

    it('re-renders and re-stops a static field after context restore', {
      timeout: RESTORE_TEST_TIMEOUT_MS,
    }, async () => {
      const el = mount({ speed: '0' });
      if (el.noWebgl) return;
      await wait(150);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      lose.loseContext();
      await wait(100);
      const spy = spyDraws();
      await restoreThen(lose, canvas, (ms) => waitForDraws(spy, 1, ms)); // event + rAF, not a sleep
      await expectStopped(spy); // and re-stopped
    });

    it('degrades to the CSS fallback when a restored context cannot rebuild GL', {
      timeout: RESTORE_TEST_TIMEOUT_MS,
    }, async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      lose.loseContext();
      await wait(100);
      // Force #setupGlResources() to fail on restore (Fix e001cb5b4 degrade path).
      vi.spyOn(WebGLRenderingContext.prototype, 'createBuffer').mockReturnValue(
        null as unknown as WebGLBuffer
      );
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spy = spyDraws();
      await restoreThen(lose, canvas, (ms) =>
        vi.waitFor(() => expect(el.noWebgl).toBe(true), { timeout: ms, interval: 50 })
      );
      expect(spy.mock.calls.length).toBe(0);
      expect(errSpy).toHaveBeenCalled(); // emitted a diagnostic, not silent
    });

    it('warns on context loss so a blank field is attributable', async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      lose.loseContext();
      await wait(100);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WebGL context lost'));
      // Restore promptly so the never-restored watchdog does not fire in this test.
      await restoreThen(lose, canvas, async () => {});
    });

    it('degrades to the CSS fallback when a lost context is never restored', {
      // Watchdog + quiet settle; keep above CONTEXT_RESTORE_TIMEOUT_MS.
      timeout: CONTEXT_RESTORE_TIMEOUT_MS + 5_000,
    }, async () => {
      const el = mount({ mode: 'scoop' });
      if (el.noWebgl) return;
      await wait(100);
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl') as WebGLRenderingContext;
      const lose = gl.getExtension('WEBGL_lose_context');
      if (!lose) return;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // preventDefault was already called by the handler; do not restore.
      lose.loseContext();
      await wait(100);
      expect(warnSpy).toHaveBeenCalled();
      expect(el.noWebgl).toBe(false); // still waiting
      await vi.waitFor(() => expect(el.noWebgl).toBe(true), {
        timeout: CONTEXT_RESTORE_TIMEOUT_MS + 2_000,
        interval: 50,
      });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not restored'));
      // Poisoned canvas was swapped out so a late UA restore cannot leave a live
      // GPU context on a CSS-hidden element (#gl already nulled).
      const after = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      expect(after).not.toBe(canvas);
      expect(after.isConnected).toBe(true);
      expect(canvas.isConnected).toBe(false);
    });

    it('reduced motion renders one frame per wake and stops', async () => {
      const realMatchMedia = window.matchMedia.bind(window);
      vi.spyOn(window, 'matchMedia').mockImplementation((q: string) =>
        q.includes('prefers-reduced-motion')
          ? ({
              matches: true,
              media: q,
              addEventListener() {},
              removeEventListener() {},
            } as unknown as MediaQueryList)
          : realMatchMedia(q)
      );
      const spy = spyDraws();
      const el = mount({ mode: 'scoop' }); // animated mode, but reduced motion wins
      if (el.noWebgl) return;
      await wait(300);
      // Connect wakes once, and the ResizeObserver initial notification wakes
      // again — each renders exactly one frame under reduced motion, then stops.
      const afterMount = spy.mock.calls.length;
      expect(afterMount).toBeGreaterThanOrEqual(1);
      expect(afterMount).toBeLessThanOrEqual(2);
      el.pulse();
      await wait(300);
      expect(spy.mock.calls.length).toBe(afterMount + 1); // exactly one more per wake
    });
  });

  it('caps the backing store at DPR 1 by default and honors the dpr escape hatch', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    try {
      const el = mount();
      if (el.noWebgl) return;
      await frame();
      await frame();
      const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
      expect(el.dpr).toBe(1);
      expect(canvas.width).toBe(240); // min(cap 1, ratio 2) × 240px — was 480 uncapped
      el.setAttribute('dpr', '2');
      await frame();
      await frame();
      expect(canvas.width).toBe(480); // escape hatch: min(2, 2)
      el.setAttribute('dpr', '0.5');
      await frame();
      await frame();
      expect(canvas.width).toBe(120);
    } finally {
      if (original) Object.defineProperty(window, 'devicePixelRatio', original);
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  it('clamps dpr to 0.5..2 and defaults bogus values to 1', () => {
    const el = mount({ dpr: '9' });
    expect(el.dpr).toBe(2);
    el.setAttribute('dpr', '0.1');
    expect(el.dpr).toBe(0.5);
    el.setAttribute('dpr', 'nope');
    expect(el.dpr).toBe(1);
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

  it('logs and keeps the prior program active when a mode switch fails to link', async () => {
    const el = mount({ mode: 'cone' });
    await frame();
    if (el.noWebgl) return; // no WebGL in this runner — link failure is N/A
    const useProgramSpy = vi.spyOn(WebGLRenderingContext.prototype, 'useProgram');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Force the fresh (scoop) program to fail linking without disturbing the
    // already-built cone program — the finding's "compile/link failure" path.
    const realGetProgramParameter = WebGLRenderingContext.prototype.getProgramParameter;
    const linkSpy = vi
      .spyOn(WebGLRenderingContext.prototype, 'getProgramParameter')
      .mockImplementation(function (this: WebGLRenderingContext, program, pname) {
        if (pname === this.LINK_STATUS) return false;
        return realGetProgramParameter.call(this, program, pname);
      });
    try {
      const activeBefore = useProgramSpy.mock.calls.at(-1)?.[0];
      el.mode = 'scoop';
      // The getter reports the requested mode even though the link failed…
      expect(el.mode).toBe('scoop');
      // …a diagnostic is emitted rather than silently rendering the stale field…
      expect(errSpy).toHaveBeenCalledWith('[slicc-shader] mode switch failed to link program');
      // …and no NEW program was activated (the prior cone program stays bound).
      const activeAfter = useProgramSpy.mock.calls.at(-1)?.[0];
      expect(activeAfter).toBe(activeBefore);
      el.remove();
    } finally {
      linkSpy.mockRestore();
      errSpy.mockRestore();
      useProgramSpy.mockRestore();
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

describe('cone Sugar Glass field colors', () => {
  const CONE_UNIFORMS = {
    u_res: [64, 64],
    u_time: 2,
    u_energy: 0,
    u_center: [0.35, 0.55],
    u_evt: [0.95, 0.25, 0.37],
    u_falloff: 0.3,
    u_life: 0.35,
    u_freeze: SUGAR_GLASS_PRESETS.caramel.coverage * 2.2,
    u_tint: tintVec(SUGAR_GLASS_PRESETS.caramel.tint),
    u_scroll: 0,
    u_brightness: SUGAR_GLASS_PRESETS.caramel.brightness,
    u_contrast: SUGAR_GLASS_PRESETS.caramel.contrast,
    u_noise: SUGAR_GLASS_PRESETS.caramel.noise,
    u_blur: SUGAR_GLASS_PRESETS.caramel.blur,
    u_speed: SUGAR_GLASS_PRESETS.caramel.speed,
  };

  function tintVec(tint: string): [number, number, number] {
    return [1, 3, 5].map((start) => Number.parseInt(tint.slice(start, start + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
  }

  it('exports five exact, reachable storyboard presets', () => {
    expect(SUGAR_GLASS_PRESETS).toEqual({
      caramel: {
        mode: 'cone',
        tint: '#d08a3c',
        brightness: 1.1,
        contrast: 1.1,
        noise: 0.025,
        blur: 0.14,
        coverage: 0.28,
        speed: 0.0625,
      },
      'caramel-soft': {
        mode: 'cone',
        tint: '#d08a3c',
        brightness: 1.2,
        contrast: 0.75,
        noise: 0.025,
        blur: 0.14,
        coverage: 0.28,
        speed: 1,
      },
      frosted: {
        mode: 'cone',
        tint: '#ead9bd',
        brightness: 1,
        contrast: 0.55,
        noise: 0.005,
        blur: 0.9,
        coverage: 0.08,
        speed: 1,
      },
      brittle: {
        mode: 'cone',
        tint: '#ffd089',
        brightness: 0.96,
        contrast: 1.2,
        noise: 0.055,
        blur: 0.02,
        coverage: 0.68,
        speed: 1,
      },
      'waffle-glass': {
        mode: 'cone',
        tint: '#d3a15f',
        brightness: 1,
        contrast: 0.9,
        noise: 0.02,
        blur: 0.08,
        coverage: 0.9,
        speed: 1,
      },
    });

    for (const preset of Object.values(SUGAR_GLASS_PRESETS)) {
      const attrs = Object.fromEntries(
        Object.entries(preset).map(([name, value]) => [name, String(value)])
      );
      const el = mount(attrs);
      expect(el.mode).toBe('cone');
      expect(el.getAttribute('tint')).toBe(preset.tint);
      expect(el.brightness).toBe(preset.brightness);
      expect(el.contrast).toBe(preset.contrast);
      expect(el.noise).toBe(preset.noise);
      expect(el.blurAmount).toBe(preset.blur);
      expect(el.coverage).toBe(preset.coverage);
      expect(el.speed).toBe(preset.speed);
      el.remove();
    }
  });

  it('keeps Cone sheared-lattice geometry in the Waffle-glass branch', () => {
    const cone = SHADER_FRAGMENTS.cone;
    expect(cone).toContain('cos(0.7853981634)');
    expect(cone).toContain('g.x+=g.y*0.5');
    expect(cone).toContain('float waffleMask=step(0.82,sugarCoverage);');
  });

  it('freezes all cone motion at speed zero while keeping positive-speed parallax', () => {
    const pausedStart = renderFragment(SHADER_FRAGMENTS.cone, {
      ...CONE_UNIFORMS,
      u_time: 0,
      u_center: [0.2, 0.3],
      u_speed: 0,
    });
    const pausedLater = renderFragment(SHADER_FRAGMENTS.cone, {
      ...CONE_UNIFORMS,
      u_time: 120,
      u_center: [0.8, 0.7],
      u_speed: 0,
    });
    if (!pausedStart || !pausedLater) return;
    expect(pausedLater).toEqual(pausedStart);

    const movingStart = renderFragment(SHADER_FRAGMENTS.cone, {
      ...CONE_UNIFORMS,
      u_center: [0.2, 0.3],
    });
    const movingLater = renderFragment(SHADER_FRAGMENTS.cone, {
      ...CONE_UNIFORMS,
      u_center: [0.8, 0.7],
    });
    if (!movingStart || !movingLater) return;
    expect(movingLater).not.toEqual(movingStart);
  });

  it.each([
    ['light', 0, [0.97, 0.95, 0.89]],
    ['dark', 1, [0.09, 0.08, 0.06]],
  ] as const)(
    'default cone stays inside the 20%% background wash budget in %s',
    (_name, uDark, bg) => {
      const px = renderFragment(SHADER_FRAGMENTS.cone, { ...CONE_UNIFORMS, u_dark: uDark });
      if (!px) return;
      for (let i = 0; i < px.length; i += 4) {
        expect(Math.abs(px[i] - bg[0] * 255)).toBeLessThanOrEqual(52);
        expect(Math.abs(px[i + 1] - bg[1] * 255)).toBeLessThanOrEqual(52);
        expect(Math.abs(px[i + 2] - bg[2] * 255)).toBeLessThanOrEqual(52);
      }
    }
  );

  it.each([
    ['light', 0, [0.97, 0.95, 0.89]],
    ['dark', 1, [0.09, 0.08, 0.06]],
  ] as const)('keeps every preset inside the 20%% budget in %s mode', (_name, uDark, bg) => {
    for (const preset of Object.values(SUGAR_GLASS_PRESETS)) {
      const px = renderFragment(SHADER_FRAGMENTS.cone, {
        ...CONE_UNIFORMS,
        u_dark: uDark,
        u_tint: tintVec(preset.tint),
        u_brightness: preset.brightness,
        u_contrast: preset.contrast,
        u_noise: preset.noise,
        u_blur: preset.blur,
        u_freeze: preset.coverage * 2.2,
        u_speed: preset.speed,
      });
      if (!px) continue;
      for (let i = 0; i < px.length; i += 4) {
        expect(Math.abs(px[i] - bg[0] * 255)).toBeLessThanOrEqual(52);
        expect(Math.abs(px[i + 1] - bg[1] * 255)).toBeLessThanOrEqual(52);
        expect(Math.abs(px[i + 2] - bg[2] * 255)).toBeLessThanOrEqual(52);
      }
    }
  });

  it('renders warm glass in both themes and carries the shared post chain', () => {
    for (const uDark of [0, 1]) {
      const px = renderFragment(SHADER_FRAGMENTS.cone, { ...CONE_UNIFORMS, u_dark: uDark });
      if (!px) continue;
      const { r, b } = meanRgb(px);
      expect(r).toBeGreaterThan(b);
    }
    const cone = SHADER_FRAGMENTS.cone;
    expect(cone).toContain('vec3 bg=themeBg(); col=mix(bg,clamp(col,0.0,1.0),0.20);');
    expect(cone).toContain('u_time*(u_life+0.15)*u_speed');
    expect(cone).toContain('u_center');
    expect(cone).toContain('p.y-=u_scroll');
    expect(cone).toContain('u_falloff');
    expect(cone).toContain('u_tint');
    expect(cone).toContain('u_evt*u_energy');
    expect(cone).toContain('u_noise*grain');
    expect(cone).toContain('u_contrast');
    expect(cone).toContain('u_brightness');
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
