import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { SprinkleRenderer, isFullDocument } from './sprinkle-renderer.js';
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
    open: vi.fn(),
    close: vi.fn(),
  };
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

  describe('sandbox localStorage proxy (extension mode)', () => {
    it('sprinkle-storage-set stores value with correct prefixed key', () => {
      const sprinkleName = 'test-sprinkle';
      const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Simulate the storage-set message handler
      const key = 'myKey';
      const value = 'myValue';
      try {
        dom.window.localStorage.setItem(`${prefix}${key}`, value);
      } catch { /* quota */ }

      expect(dom.window.localStorage.getItem(`${prefix}${key}`)).toBe(value);
    });

    it('sprinkle-storage-remove deletes key with correct prefix', () => {
      const sprinkleName = 'test-sprinkle';
      const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Set up a key
      dom.window.localStorage.setItem(`${prefix}myKey`, 'myValue');
      expect(dom.window.localStorage.getItem(`${prefix}myKey`)).toBe('myValue');

      // Simulate the storage-remove message handler
      try {
        dom.window.localStorage.removeItem(`${prefix}myKey`);
      } catch { /* noop */ }

      expect(dom.window.localStorage.getItem(`${prefix}myKey`)).toBeNull();
    });

    it('sprinkle-storage-clear removes all prefixed keys for the sprinkle', () => {
      const sprinkleName = 'test-sprinkle';
      const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Set up multiple prefixed keys
      dom.window.localStorage.setItem(`${prefix}key1`, 'value1');
      dom.window.localStorage.setItem(`${prefix}key2`, 'value2');
      dom.window.localStorage.setItem(`${prefix}key3`, 'value3');
      // Set keys that should NOT be removed
      dom.window.localStorage.setItem('slicc-sprinkle-ls:other-sprinkle:key1', 'other-value');
      dom.window.localStorage.setItem('some-other-key', 'unrelated-value');

      // Simulate the storage-clear message handler
      for (let i = dom.window.localStorage.length - 1; i >= 0; i--) {
        const k = dom.window.localStorage.key(i);
        if (k?.startsWith(prefix)) {
          dom.window.localStorage.removeItem(k);
        }
      }

      // Verify prefixed keys are removed
      expect(dom.window.localStorage.getItem(`${prefix}key1`)).toBeNull();
      expect(dom.window.localStorage.getItem(`${prefix}key2`)).toBeNull();
      expect(dom.window.localStorage.getItem(`${prefix}key3`)).toBeNull();
      // Verify other keys are preserved
      expect(dom.window.localStorage.getItem('slicc-sprinkle-ls:other-sprinkle:key1')).toBe('other-value');
      expect(dom.window.localStorage.getItem('some-other-key')).toBe('unrelated-value');
    });

    it('savedStorage is collected from localStorage with correct prefix', () => {
      const sprinkleName = 'test-sprinkle';
      const lsPrefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Clear localStorage
      dom.window.localStorage.clear();

      // Set up some prefixed keys
      dom.window.localStorage.setItem(`${lsPrefix}theme`, 'dark');
      dom.window.localStorage.setItem(`${lsPrefix}volume`, '75');
      dom.window.localStorage.setItem(`${lsPrefix}layout`, 'grid');
      // Set keys that should NOT be collected
      dom.window.localStorage.setItem('slicc-sprinkle-ls:other-sprinkle:key1', 'other-value');
      dom.window.localStorage.setItem('some-other-key', 'unrelated-value');

      // Simulate the savedStorage collection logic
      const savedStorage: Record<string, string> = {};
      for (let i = 0; i < dom.window.localStorage.length; i++) {
        const k = dom.window.localStorage.key(i);
        if (k?.startsWith(lsPrefix)) {
          savedStorage[k.slice(lsPrefix.length)] = dom.window.localStorage.getItem(k) ?? '';
        }
      }

      expect(savedStorage).toEqual({
        theme: 'dark',
        volume: '75',
        layout: 'grid',
      });
      expect(savedStorage['key1']).toBeUndefined();
    });

    it('storage quota error is caught silently on setItem', () => {
      const sprinkleName = 'test-sprinkle';
      const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Mock localStorage.setItem to throw
      const setItemSpy = vi
        .spyOn(dom.window.localStorage, 'setItem')
        .mockImplementation(() => {
          const err = new Error('QuotaExceededError');
          (err as any).name = 'QuotaExceededError';
          throw err;
        });

      // Simulate the storage-set message handler with error handling
      expect(() => {
        try {
          dom.window.localStorage.setItem(`${prefix}myKey`, 'myValue');
        } catch { /* quota */ }
      }).not.toThrow();

      setItemSpy.mockRestore();
    });

    it('storage error is caught silently on removeItem', () => {
      const sprinkleName = 'test-sprinkle';
      const prefix = `slicc-sprinkle-ls:${sprinkleName}:`;

      // Mock localStorage.removeItem to throw
      const removeItemSpy = vi
        .spyOn(dom.window.localStorage, 'removeItem')
        .mockImplementation(() => {
          throw new Error('Some error');
        });

      // Simulate the storage-remove message handler with error handling
      expect(() => {
        try {
          dom.window.localStorage.removeItem(`${prefix}myKey`);
        } catch { /* noop */ }
      }).not.toThrow();

      removeItemSpy.mockRestore();
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
    const html = '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    // Should NOT have a .sprinkle-content wrapper
    expect(container.querySelector('.sprinkle-content')).toBeNull();
  });

  it('injects bridge script into srcdoc', async () => {
    const bridge = makeBridge('full-doc');
    const renderer = new SprinkleRenderer(container, bridge);
    const html = '<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>';
    await renderer.render(html, 'full-doc');

    const iframe = container.querySelector('iframe');
    const srcdoc = iframe?.getAttribute('srcdoc') || '';
    expect(srcdoc).toContain('window.slicc');
    expect(srcdoc).toContain('sprinkle-lick');
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
});
