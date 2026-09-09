import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SprinkleBridge, type SprinkleBridgeAPI } from '../../src/ui/sprinkle-bridge.js';
import {
  fullDocIframeStyle,
  isFullDocument,
  pinFullDocIframeToHost,
  restoreFullDocIframeFlex,
  SprinkleRenderer,
} from '../../src/ui/sprinkle-renderer.js';

function makeBridge(name: string): SprinkleBridgeAPI {
  // Device namespaces (hid/serial/usb/_device) are irrelevant to renderer tests.
  const exec = Object.assign(vi.fn(), { spawn: vi.fn() }) as SprinkleBridgeAPI['exec'];
  return {
    name,
    lick: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readDir: vi.fn(),
    exists: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    screenshot: vi.fn(),
    setState: vi.fn(),
    getState: vi.fn(() => null),
    open: vi.fn(),
    close: vi.fn(),
    minimize: vi.fn(),
    stopCone: vi.fn(),
    attachImage: vi.fn(),
    captureScreen: vi.fn(),
    exec,
    agent: vi.fn(),
    fetch: vi.fn(),
    http: { client: vi.fn() },
    browser: {
      findTab: vi.fn(),
      ensureTab: vi.fn(),
      eval: vi.fn(),
      evalAsync: vi.fn(),
      cookie: vi.fn(),
      localStorage: vi.fn(),
      fetch: vi.fn(),
    },
    readFileBinary: vi.fn(),
    writeFileBinary: vi.fn(),
    fetchToFile: vi.fn(),
    _jsh: vi.fn(),
  } as unknown as SprinkleBridgeAPI;
}

describe('SprinkleRenderer', () => {
  let dom: JSDOM;
  let container: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
      runScripts: 'dangerously',
      url: 'http://localhost',
    });
    container = dom.window.document.getElementById('root')!;
    // Set up global window for the module
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    // Ensure clean sprinkle registry
    dom.window.__slicc_sprinkles = undefined as any;
  });

  describe('onclick function hoisting', () => {
    it('hoists functions at any position in onclick, not just position 0', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <button onclick="event.stopPropagation(); doThing()">Click</button>
        <script>
          function doThing() { return 'ok'; }
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.doThing = doThing');
    });

    it('hoists multiple function calls from a single onclick', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <button onclick="validate(); submit()">Click</button>
        <script>
          function validate() {}
          function submit() {}
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.validate = validate');
      expect(script?.textContent).toContain('window.submit = submit');
    });

    it('hoists functions from return fn() patterns', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <button onclick="return runAudit()">Click</button>
        <script>
          function runAudit() {}
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.runAudit = runAudit');
    });
  });

  describe('multi-sprinkle slicc bridge isolation', () => {
    it('rewrites onclick even when sprinkle has no script tags', async () => {
      const bridge = makeBridge('sprinkle-a');
      const renderer = new SprinkleRenderer(container, bridge);

      // No <script> tag at all — onclick must still be rewritten
      const html = `
        <button onclick="slicc.lick({action:'refresh'})">Refresh</button>
      `;
      await renderer.render(html, 'sprinkle-a');

      const button = container.querySelector('button');
      const onclick = button?.getAttribute('onclick') || '';
      expect(onclick).toContain('window.__slicc_sprinkles["sprinkle-a"]');
      expect(onclick).not.toMatch(/\bslicc\b/);
    });

    it('rewrites onclick slicc references to sprinkle-specific bridge', async () => {
      const bridge = makeBridge('sprinkle-a');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <button onclick="slicc.lick({action:'refresh'})">Refresh</button>
        <script>console.log('loaded');</script>
      `;
      await renderer.render(html, 'sprinkle-a');

      const button = container.querySelector('button');
      const onclick = button?.getAttribute('onclick') || '';
      // Should reference sprinkle-specific bridge, not bare slicc
      expect(onclick).toContain('window.__slicc_sprinkles["sprinkle-a"]');
      expect(onclick).not.toMatch(/\bslicc\b/);
    });

    it('does not set window.slicc globally', async () => {
      const bridge = makeBridge('sprinkle-a');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `<script>console.log('test');</script>`;
      await renderer.render(html, 'sprinkle-a');

      const script = container.querySelector('script');
      expect(script?.textContent).not.toContain('window.slicc =');
      expect(script?.textContent).not.toContain('window.slicc=');
    });

    it('keeps slicc available as local var inside IIFE for script body', async () => {
      const bridge = makeBridge('sprinkle-a');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `<script>slicc.on('update', function(d) {});</script>`;
      await renderer.render(html, 'sprinkle-a');

      const script = container.querySelector('script');
      // Local var slicc should be assigned from registry
      expect(script?.textContent).toContain('var slicc = window.__slicc_sprinkles["sprinkle-a"]');
    });

    it('rewrites onclick bridge references the same as slicc references', async () => {
      const bridge = makeBridge('sprinkle-a');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <button onclick="bridge.lick('add-year')">Add Year</button>
        <script>console.log('loaded');</script>
      `;
      await renderer.render(html, 'sprinkle-a');

      const button = container.querySelector('button');
      const onclick = button?.getAttribute('onclick') || '';
      expect(onclick).toContain('window.__slicc_sprinkles["sprinkle-a"]');
      expect(onclick).not.toMatch(/\bbridge\b/);
    });

    it('two sprinkles get independent bridge references in onclick', async () => {
      const bridgeA = makeBridge('sprinkle-a');
      const bridgeB = makeBridge('sprinkle-b');

      // Use separate containers to simulate two sprinkles
      const containerB = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(containerB);

      const rendererA = new SprinkleRenderer(container, bridgeA);
      const rendererB = new SprinkleRenderer(containerB, bridgeB);

      await rendererA.render(
        `<button id="a" onclick="slicc.lick({action:'a'})">A</button><script></script>`,
        'sprinkle-a'
      );
      await rendererB.render(
        `<button id="b" onclick="slicc.lick({action:'b'})">B</button><script></script>`,
        'sprinkle-b'
      );

      const btnA = container.querySelector('#a');
      const btnB = containerB.querySelector('#b');

      expect(btnA?.getAttribute('onclick')).toContain('__slicc_sprinkles["sprinkle-a"]');
      expect(btnB?.getAttribute('onclick')).toContain('__slicc_sprinkles["sprinkle-b"]');
    });
  });
});

describe('isFullDocument detection', () => {
  it('detects DOCTYPE', () => {
    expect(isFullDocument('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true);
  });
  it('detects <html> tag', () => {
    expect(isFullDocument('<html><body>hi</body></html>')).toBe(true);
  });
  it('rejects fragment div', () => {
    expect(isFullDocument('<div class="sprinkle-card">hello</div>')).toBe(false);
  });
  it('handles whitespace-prefixed doctype', () => {
    expect(isFullDocument('  \n  <!doctype html><html></html>')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isFullDocument('<!DOCTYPE HTML><HTML></HTML>')).toBe(true);
  });
});

describe('full document rendering', () => {
  let dom: JSDOM;
  let container: HTMLElement;

  function sizeHost(el: HTMLElement, width: number, height: number): void {
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height });
  }

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
      runScripts: 'dangerously',
    });
    container = dom.window.document.getElementById('root')!;
    (globalThis as any).window = dom.window;
    (globalThis as any).document = dom.window.document;
    dom.window.__slicc_sprinkles = undefined as any;
  });

  it('creates an iframe for full HTML documents', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html =
      '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    // Should NOT have a .sprinkle-content wrapper
    expect(container.querySelector('.sprinkle-content')).toBeNull();
  });

  it('specifies height: 100% so Chromium gets a definite viewport, not just flex', () => {
    expect(fullDocIframeStyle(false)).toContain('width: 100%');
    expect(fullDocIframeStyle(false)).toContain('height: 100%');
    expect(fullDocIframeStyle(false)).toContain('flex: 1');
    expect(fullDocIframeStyle(false)).not.toContain('translateZ');
    expect(fullDocIframeStyle(true)).toContain('transform: translateZ(0)');
  });

  it('pins a sized host box and restores percentage sizing after load', () => {
    const iframe = dom.window.document.createElement('iframe');
    iframe.style.cssText = fullDocIframeStyle(false);
    sizeHost(container, 1072, 1020);

    expect(pinFullDocIframeToHost(iframe, container)).toBe(true);
    expect(iframe.style.width).toBe('1072px');
    expect(iframe.style.height).toBe('1020px');

    restoreFullDocIframeFlex(iframe);
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');
  });

  it('does not pin when the host is 0×0 (first open, mid-transition)', () => {
    const iframe = dom.window.document.createElement('iframe');
    iframe.style.cssText = fullDocIframeStyle(false);

    expect(pinFullDocIframeToHost(iframe, container)).toBe(false);
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');
  });

  it('pins a sized host on insert, then restores flex after load (#2942 reload)', async () => {
    sizeHost(container, 1072, 1020);
    const widthsOnInsert: string[] = [];
    const heightsOnInsert: string[] = [];
    const appendChild = container.appendChild.bind(container);
    vi.spyOn(container, 'appendChild').mockImplementation((node) => {
      const iframe = node as HTMLIFrameElement;
      widthsOnInsert.push(iframe.style.width);
      heightsOnInsert.push(iframe.style.height);
      return appendChild(node);
    });

    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    await renderer.render(
      '<!DOCTYPE html><html><head></head><body>reload</body></html>',
      'full-doc'
    );

    expect(widthsOnInsert).toEqual(['1072px']);
    expect(heightsOnInsert).toEqual(['1020px']);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');
  });

  it('re-pins a sized host when the same container is re-rendered (reload)', async () => {
    sizeHost(container, 1072, 1020);
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>v1</body></html>';
    await renderer.render(html, 'full-doc');

    const widthsOnInsert: string[] = [];
    const appendChild = container.appendChild.bind(container);
    vi.spyOn(container, 'appendChild').mockImplementation((node) => {
      widthsOnInsert.push((node as HTMLIFrameElement).style.width);
      return appendChild(node);
    });

    await renderer.render('<!DOCTYPE html><html><head></head><body>v2</body></html>', 'full-doc');

    expect(widthsOnInsert).toEqual(['1072px']);
    expect(container.querySelector('iframe')?.style.width).toBe('100%');
    expect(container.querySelector('iframe')?.style.height).toBe('100%');
  });

  it('the in-iframe usb shim exposes every method the page-side API has', async () => {
    // The sprinkle's `slicc.usb` is a hand-written shim inside the srcdoc,
    // separate from `SprinkleBridge.createAPI`. Adding a method to one and
    // not the other compiles and unit-tests clean, then fails at runtime with
    // "slicc.usb.<name> is not a function" — which is exactly how the
    // transfer surface first shipped half-wired.
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    await renderer.render(
      '<!DOCTYPE html><html><head><title>T</title></head><body></body></html>',
      'full-doc'
    );
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';

    // Source of truth is the real page-side API, not the hand-built fake.
    const real = new SprinkleBridge(
      {} as never,
      vi.fn() as never,
      vi.fn() as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn().mockResolvedValue({ base64: '', width: 0, height: 0, mimeType: 'image/png' }),
      undefined,
      vi.fn()
    ).createAPI('parity');
    const pageSide = Object.keys(real.usb as unknown as Record<string, unknown>);
    expect(pageSide.length).toBeGreaterThan(4);
    for (const method of pageSide) {
      expect(srcdoc, `slicc.usb.${method} missing from the iframe shim`).toContain(
        `${method}: function(`
      );
    }
  });

  it('injects bridge script into srcdoc', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html =
      '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe');
    const srcdoc = iframe?.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('window.slicc');
    expect(srcdoc).toContain('sprinkle-lick');
    // exec/agent bridge methods are wired into the srcdoc bridge script
    expect(srcdoc).toContain('sprinkle-exec');
    expect(srcdoc).toContain('sprinkle-agent');
    // Dual copy of slicc.screenshot() — keep in lockstep with sprinkle-screenshot.ts.
    expect(srcdoc).toContain('Element has zero dimensions');
    expect(srcdoc).toContain('image decode failed');
    expect(srcdoc).toContain('XMLSerializer threw');
    expect(srcdoc).toContain('http://www.w3.org/1999/xhtml');
    expect(srcdoc).toContain('var screenshotTargetLabel = ');
    // iframe rebuilds Response from the cloneable SprinkleFetchResult wire.
    expect(srcdoc).toContain('var buildFetchResponse = ');
    expect(srcdoc).toContain('.then(function(v) { return buildFetchResponse(v); })');
  });

  it('handles bridge calls posted while the iframe is being appended', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.readFile as ReturnType<typeof vi.fn>).mockResolvedValue('hydrated');
    const renderer = new SprinkleRenderer(container, bridge);
    const appendChild = container.appendChild.bind(container);
    vi.spyOn(container, 'appendChild').mockImplementation((node) => {
      const result = appendChild(node);
      const iframe = node as HTMLIFrameElement;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: { type: 'sprinkle-readfile', id: 'early-read', path: '/shared/state.json' },
          source: iframe.contentWindow,
        })
      );
      return result;
    });

    await renderer.render('<!DOCTYPE html><html><head></head><body></body></html>', 'full-doc');

    expect(bridge.readFile).toHaveBeenCalledWith('/shared/state.json');
  });

  it('defers lifecycle calls until the owner registers the renderer', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const appendChild = container.appendChild.bind(container);
    vi.spyOn(container, 'appendChild').mockImplementation((node) => {
      const result = appendChild(node);
      const iframe = node as HTMLIFrameElement;
      dom.window.dispatchEvent(
        new dom.window.MessageEvent('message', {
          data: { type: 'sprinkle-close' },
          source: iframe.contentWindow,
        })
      );
      return result;
    });

    await renderer.render('<!DOCTYPE html><html><head></head><body></body></html>', 'full-doc');
    expect(bridge.close).not.toHaveBeenCalled();

    renderer.activateBridgeLifecycle();
    expect(bridge.close).toHaveBeenCalledOnce();
  });

  it('cleans up the early listener when iframe loading fails', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    let iframe: HTMLIFrameElement | undefined;
    vi.spyOn(container, 'appendChild').mockImplementation((node) => {
      iframe = node as HTMLIFrameElement;
      iframe.dispatchEvent(new dom.window.Event('error'));
      return node;
    });

    await expect(
      renderer.render('<!DOCTYPE html><html><head></head><body></body></html>', 'full-doc')
    ).rejects.toThrow('full-doc iframe failed to load');

    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { type: 'sprinkle-readfile', id: 'late-read', path: '/shared/state.json' },
        source: iframe!.contentWindow,
      })
    );
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it('updates and clears preset overrides in the iframe bridge', async () => {
    const renderer = new SprinkleRenderer(container, makeBridge('theme-test'));
    await renderer.render(
      '<!DOCTYPE html><html><head></head><body>Theme</body></html>',
      'theme-test'
    );
    const srcdoc = container.querySelector('iframe')!.srcdoc;
    const frameDom = new JSDOM(srcdoc, { runScripts: 'dangerously' });
    const root = frameDom.window.document.documentElement;
    const theme = (isLight: boolean, overrides: object | null) => {
      frameDom.window.dispatchEvent(
        new frameDom.window.MessageEvent('message', {
          data: { type: 'slicc-theme', isLight, overrides },
        })
      );
    };
    theme(false, { '--s2-accent': '#abcdef', '--s2-bg-base': '#101010' });
    expect(root.classList.contains('theme-light')).toBe(false);
    expect(root.style.getPropertyValue('--s2-accent')).toBe('#abcdef');
    theme(true, { '--s2-accent': '#123456' });
    expect(root.classList.contains('theme-light')).toBe(true);
    expect(root.style.getPropertyValue('--s2-accent')).toBe('#123456');
    expect(root.style.getPropertyValue('--s2-bg-base')).toBe('');
    theme(true, null);
    expect(root.style.getPropertyValue('--s2-accent')).toBe('');
    frameDom.window.close();
    renderer.dispose();
  });

  it('rehydrates the current state and theme after an iframe reload', async () => {
    const bridge = makeBridge('work-list');
    const getState = vi.mocked(bridge.getState);
    getState.mockReturnValue({ items: ['first'] });
    const renderer = new SprinkleRenderer(container, bridge);
    await renderer.render(
      '<!DOCTYPE html><html><head></head><body>Queue</body></html>',
      'work-list'
    );
    const iframe = container.querySelector('iframe')!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage');

    getState.mockReturnValue({ items: ['first', 'second'] });
    dom.window.document.body.setAttribute('data-theme', 'light');
    iframe.dispatchEvent(new dom.window.Event('load'));
    expect(post).toHaveBeenCalledWith({ type: 'slicc-theme', isLight: true, overrides: null }, '*');
    expect(post).toHaveBeenCalledWith(
      { type: 'sprinkle-init', name: 'work-list', savedState: { items: ['first', 'second'] } },
      '*'
    );

    post.mockClear();
    dom.window.document.body.setAttribute('data-theme', 'dark');
    iframe.dispatchEvent(new dom.window.Event('load'));
    expect(post).toHaveBeenCalledWith(
      { type: 'slicc-theme', isLight: false, overrides: null },
      '*'
    );
    renderer.dispose();
    post.mockClear();
    iframe.dispatchEvent(new dom.window.Event('load'));
    expect(post).not.toHaveBeenCalled();
  });

  it('dispose removes full-doc iframe', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');
    expect(container.querySelector('iframe')).toBeTruthy();
    renderer.dispose();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('nudges the iframe repaint when the page itself is framed (cherry)', async () => {
    // Simulate the cherry follower: this page is embedded in another frame,
    // so `window.self !== window.top`. jsdom's `top` getter isn't
    // configurable, so override `self` instead — the source checks equality
    // between the two either way.
    (dom.window as any).self = {};
    const rafCallbacks: Array<() => void> = [];
    const originalRaf = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe).toBeTruthy();
    // The repaint nudge hides the iframe immediately after load...
    expect(iframe.style.display).toBe('none');
    expect(rafCallbacks.length).toBe(1);
    // ...then restores it across two animation frames.
    rafCallbacks.shift()!();
    expect(rafCallbacks.length).toBe(1);
    rafCallbacks.shift()!();
    expect(iframe.style.display).toBe('');

    (globalThis as any).requestAnimationFrame = originalRaf;
  });

  it('does not nudge the iframe repaint when the page is top-level (standalone follower)', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.display).not.toBe('none');
  });

  it('re-nudges the iframe repaint when a hidden cherry sprinkle surface becomes visible again', async () => {
    // The sprinkle's `<slicc-surface>` host stays mounted and toggles
    // `display:none`/`display:flex` on tab switches — no new `load` event
    // fires on re-show, so only an IntersectionObserver-driven re-nudge can
    // catch the Chromium compositor bug resurfacing on a later show.
    (dom.window as any).self = {};
    const rafCallbacks: Array<() => void> = [];
    const originalRaf = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    const originalIO = (globalThis as any).IntersectionObserver;
    class FakeIntersectionObserver {
      constructor(cb: typeof observerCallback) {
        observerCallback = cb;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = unobserve;
    }
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;

    try {
      const bridge = makeBridge('full-doc');
      const renderer = new SprinkleRenderer(container, bridge);
      const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
      await renderer.render(html, 'full-doc');

      expect(observe).toHaveBeenCalled();
      // Consume the initial-load nudge's raf pair before simulating tab switches.
      rafCallbacks.shift()!();
      rafCallbacks.shift()!();
      rafCallbacks.length = 0;

      // First observer callback with isIntersecting: true triggers a nudge —
      // this covers the case where the iframe loaded while its container was
      // not yet visible (e.g. workbench mid-transition in cherry mode).
      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(1);
      expect(unobserve).toHaveBeenCalledTimes(1);

      // Complete the nudge's rAF pair — re-observe fires a synthetic callback.
      rafCallbacks.shift()!();
      rafCallbacks.shift()!();
      rafCallbacks.length = 0;
      expect(observe).toHaveBeenCalledTimes(2); // initial + re-observe after nudge

      // The post-re-observe callback with isIntersecting: true must be skipped
      // (it's the nudge's own display restore, not a real visibility change).
      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(0); // no infinite loop

      // Tab switched away, then back: a later hidden -> visible transition
      // must trigger a fresh nudge.
      observerCallback!([{ isIntersecting: false }]);
      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(1);
      expect(unobserve).toHaveBeenCalledTimes(2);

      // Complete the second nudge — no infinite loop.
      rafCallbacks.shift()!();
      rafCallbacks.shift()!();
      expect(observe).toHaveBeenCalledTimes(3); // initial + 2 re-observes
      // Post-nudge synthetic callback is skipped.
      observerCallback!([{ isIntersecting: true }]);
      expect(rafCallbacks.length).toBe(0);
    } finally {
      (globalThis as any).requestAnimationFrame = originalRaf;
      (globalThis as any).IntersectionObserver = originalIO;
    }
  });

  it('grants allow-popups on the sprinkle iframe when the page itself is framed (cherry)', async () => {
    (dom.window as any).self = {};
    const originalRaf = (globalThis as any).requestAnimationFrame;
    (globalThis as any).requestAnimationFrame = () => 0;

    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups');

    (globalThis as any).requestAnimationFrame = originalRaf;
  });

  it('does not grant allow-popups when the page is top-level (standalone follower)', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
  });

  it('handles sprinkle-capture-screen message and posts response', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.captureScreen as ReturnType<typeof vi.fn>).mockResolvedValue({
      base64: 'abc',
      width: 100,
      height: 50,
      mimeType: 'image/png',
    });
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe')!;
    // Mock postMessage on the iframe's contentWindow
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    // Simulate the message from the iframe
    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-capture-screen', id: 'req-1' },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);

    // Wait for the async captureScreen to resolve
    await Promise.resolve();
    expect(bridge.captureScreen).toHaveBeenCalled();
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: 'sprinkle-capture-screen-response',
        id: 'req-1',
        base64: 'abc',
        width: 100,
        height: 50,
        mimeType: 'image/png',
      },
      '*'
    );
  });

  it('handles sprinkle-capture-screen error and posts error response', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.captureScreen as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Screen capture denied')
    );
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-capture-screen', id: 'req-2' },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await Promise.resolve();
    expect(bridge.captureScreen).toHaveBeenCalled();
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: 'sprinkle-capture-screen-response',
        id: 'req-2',
        error: 'Screen capture denied',
      },
      '*'
    );
  });

  it('handles sprinkle-exec message and posts result response', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.exec as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    });
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-exec', id: 'exec-1', cmd: 'echo hi' },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await Promise.resolve();

    expect(bridge.exec).toHaveBeenCalledWith('echo hi');
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: 'sprinkle-exec-response',
        id: 'exec-1',
        result: { stdout: 'hi\n', stderr: '', exitCode: 0 },
      },
      '*'
    );
  });

  it('handles sprinkle-exec rejection and posts error response', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.exec as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('shell down'));
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-exec', id: 'exec-2', cmd: 'boom' },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await Promise.resolve();

    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'sprinkle-exec-response', id: 'exec-2', error: 'shell down' },
      '*'
    );
  });

  it('handles sprinkle-agent message and posts result response', async () => {
    const bridge = makeBridge('full-doc');
    (bridge.agent as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: 'done',
      exitCode: 0,
    });
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head></head><body>Hi</body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const opts = { cwd: '/workspace', model: 'claude-opus-4-6' };
    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-agent', id: 'agent-1', prompt: 'do it', opts },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await Promise.resolve();

    expect(bridge.agent).toHaveBeenCalledWith('do it', opts);
    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: 'sprinkle-agent-response',
        id: 'agent-1',
        result: { stdout: 'done', exitCode: 0 },
      },
      '*'
    );
  });

  it('posts a structured-cloneable sprinkle-jsh fetch payload', async () => {
    const bridge = makeBridge('full-doc');
    const wire = {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://example.com/',
      headers: { 'content-type': 'text/plain' },
      bodyBase64: btoa('hello'),
    };
    (bridge._jsh as ReturnType<typeof vi.fn>).mockResolvedValue(wire);
    const renderer = new SprinkleRenderer(container, bridge);
    await renderer.render('<!DOCTYPE html><html><head></head><body>Hi</body></html>', 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn((data: unknown) => {
      structuredClone(data);
    });
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const event = new dom.window.MessageEvent('message', {
      data: {
        type: 'sprinkle-jsh',
        id: 'fetch-1',
        op: 'fetch',
        args: ['https://example.com/', null],
      },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalled());

    expect(bridge._jsh).toHaveBeenCalledWith('fetch', ['https://example.com/', null]);
    const payload = postMessageSpy.mock.calls[0][0] as {
      type: string;
      id: string;
      result: unknown;
    };
    expect(payload).toEqual({
      type: 'sprinkle-jsh-response',
      id: 'fetch-1',
      result: wire,
    });
    expect(() => structuredClone(payload)).not.toThrow();
  });

  it('posts { error } instead of hanging when the jsh result is not cloneable', async () => {
    const bridge = makeBridge('full-doc');
    (bridge._jsh as ReturnType<typeof vi.fn>).mockResolvedValue(new Response('nope'));
    const renderer = new SprinkleRenderer(container, bridge);
    await renderer.render('<!DOCTYPE html><html><head></head><body>Hi</body></html>', 'full-doc');

    const iframe = container.querySelector('iframe')!;
    const postMessageSpy = vi.fn((data: unknown) => {
      structuredClone(data);
    });
    Object.defineProperty(iframe, 'contentWindow', {
      value: { postMessage: postMessageSpy },
      writable: true,
    });

    const event = new dom.window.MessageEvent('message', {
      data: { type: 'sprinkle-jsh', id: 'fetch-bad', op: 'fetch', args: ['https://example.com/'] },
      source: iframe.contentWindow as any,
    });
    dom.window.dispatchEvent(event);
    await vi.waitFor(() => expect(postMessageSpy).toHaveBeenCalled());

    const payload = postMessageSpy.mock.calls[postMessageSpy.mock.calls.length - 1][0] as {
      type: string;
      id: string;
      error?: string;
    };
    expect(payload.type).toBe('sprinkle-jsh-response');
    expect(payload.id).toBe('fetch-bad');
    expect(payload.error).toMatch(/could not be cloned|DataCloneError|unsupported type/);
  });
});
