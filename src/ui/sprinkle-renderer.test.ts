import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { SprinkleRenderer } from './sprinkle-renderer.js';
import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';

function makeBridge(name: string): SprinkleBridgeAPI {
  return {
    name,
    lick: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    readFile: vi.fn(),
    setState: vi.fn(),
    getState: vi.fn(() => null),
    close: vi.fn(),
  };
}

describe('SprinkleRenderer', () => {
  let dom: JSDOM;
  let container: HTMLElement;

  beforeEach(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
      runScripts: 'dangerously',
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

    it('auto-hoists all declared functions, not just onclick-referenced ones', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <input type="range" oninput="updateAll()">
        <script>
          function updateAll() { return 'updated'; }
          function renderPreview() { return 'rendered'; }
          function generatePrompt() { return 'prompt'; }
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      // All declared functions should be hoisted, even without onclick references
      expect(script?.textContent).toContain('window.updateAll = updateAll');
      expect(script?.textContent).toContain('window.renderPreview = renderPreview');
      expect(script?.textContent).toContain('window.generatePrompt = generatePrompt');
    });

    it('does not hoist underscore-prefixed private functions', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <script>
          var _debounceTimer;
          function _privateHelper() {}
          function publicFn() { _privateHelper(); }
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.publicFn = publicFn');
      expect(script?.textContent).not.toContain('window._privateHelper');
      expect(script?.textContent).not.toContain('window._debounceTimer');
    });

    it('hoists var-assigned function expressions', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <script>
          var myHandler = function() { return 42; };
        </script>
      `;
      await renderer.render(html, 'test-sprinkle');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.myHandler = myHandler');
    });
  });

  describe('custom CSS extraction', () => {
    it('extracts style blocks and injects them as separate elements', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <style>.my-custom { color: red; }</style>
        <div class="my-custom">Hello</div>
        <script>console.log('ok');</script>
      `;
      await renderer.render(html, 'test-sprinkle');

      // Custom style should be injected as a separate element
      const style = container.querySelector('style[data-sprinkle="test-sprinkle"]');
      expect(style).toBeTruthy();
      expect(style?.textContent).toContain('.my-custom { color: red; }');

      // The wrapper content should NOT contain the <style> tag
      const wrapper = container.querySelector('.sprinkle-content');
      expect(wrapper?.querySelector('style')).toBeNull();
    });

    it('removes custom style on dispose', async () => {
      const bridge = makeBridge('test-sprinkle');
      const renderer = new SprinkleRenderer(container, bridge);

      const html = `
        <style>.custom { display: block; }</style>
        <div>content</div>
      `;
      await renderer.render(html, 'test-sprinkle');
      expect(container.querySelector('style[data-sprinkle]')).toBeTruthy();

      renderer.dispose();
      expect(container.querySelector('style[data-sprinkle]')).toBeNull();
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
        'sprinkle-a',
      );
      await rendererB.render(
        `<button id="b" onclick="slicc.lick({action:'b'})">B</button><script></script>`,
        'sprinkle-b',
      );

      const btnA = container.querySelector('#a');
      const btnB = containerB.querySelector('#b');

      expect(btnA?.getAttribute('onclick')).toContain('__slicc_sprinkles["sprinkle-a"]');
      expect(btnB?.getAttribute('onclick')).toContain('__slicc_sprinkles["sprinkle-b"]');
    });
  });
});
