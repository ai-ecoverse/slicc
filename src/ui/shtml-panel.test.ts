import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ShtmlPanelRenderer } from './shtml-panel.js';
import type { ShtmlBridgeAPI } from './shtml-bridge.js';

function makeBridge(name: string): ShtmlBridgeAPI {
  return {
    name,
    lick: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    readFile: vi.fn(),
    close: vi.fn(),
  };
}

describe('ShtmlPanelRenderer', () => {
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
    // Ensure clean panel registry
    dom.window.__slicc_panels = undefined as any;
  });

  describe('onclick function hoisting', () => {
    it('hoists functions at any position in onclick, not just position 0', async () => {
      const bridge = makeBridge('test-panel');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `
        <button onclick="event.stopPropagation(); doThing()">Click</button>
        <script>
          function doThing() { return 'ok'; }
        </script>
      `;
      await renderer.render(html, 'test-panel');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.doThing = doThing');
    });

    it('hoists multiple function calls from a single onclick', async () => {
      const bridge = makeBridge('test-panel');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `
        <button onclick="validate(); submit()">Click</button>
        <script>
          function validate() {}
          function submit() {}
        </script>
      `;
      await renderer.render(html, 'test-panel');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.validate = validate');
      expect(script?.textContent).toContain('window.submit = submit');
    });

    it('hoists functions from return fn() patterns', async () => {
      const bridge = makeBridge('test-panel');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `
        <button onclick="return runAudit()">Click</button>
        <script>
          function runAudit() {}
        </script>
      `;
      await renderer.render(html, 'test-panel');

      const script = container.querySelector('script');
      expect(script?.textContent).toContain('window.runAudit = runAudit');
    });
  });

  describe('multi-panel slicc bridge isolation', () => {
    it('rewrites onclick slicc references to panel-specific bridge', async () => {
      const bridge = makeBridge('panel-a');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `
        <button onclick="slicc.lick({action:'refresh'})">Refresh</button>
        <script>console.log('loaded');</script>
      `;
      await renderer.render(html, 'panel-a');

      const button = container.querySelector('button');
      const onclick = button?.getAttribute('onclick') || '';
      // Should reference panel-specific bridge, not bare slicc
      expect(onclick).toContain('window.__slicc_panels["panel-a"]');
      expect(onclick).not.toMatch(/\bslicc\b/);
    });

    it('does not set window.slicc globally', async () => {
      const bridge = makeBridge('panel-a');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `<script>console.log('test');</script>`;
      await renderer.render(html, 'panel-a');

      const script = container.querySelector('script');
      expect(script?.textContent).not.toContain('window.slicc =');
      expect(script?.textContent).not.toContain('window.slicc=');
    });

    it('keeps slicc available as local var inside IIFE for script body', async () => {
      const bridge = makeBridge('panel-a');
      const renderer = new ShtmlPanelRenderer(container, bridge);

      const html = `<script>slicc.on('update', function(d) {});</script>`;
      await renderer.render(html, 'panel-a');

      const script = container.querySelector('script');
      // Local var slicc should be assigned from registry
      expect(script?.textContent).toContain('var slicc = window.__slicc_panels["panel-a"]');
    });

    it('two panels get independent bridge references in onclick', async () => {
      const bridgeA = makeBridge('panel-a');
      const bridgeB = makeBridge('panel-b');

      // Use separate containers to simulate two panels
      const containerB = dom.window.document.createElement('div');
      dom.window.document.body.appendChild(containerB);

      const rendererA = new ShtmlPanelRenderer(container, bridgeA);
      const rendererB = new ShtmlPanelRenderer(containerB, bridgeB);

      await rendererA.render(
        `<button id="a" onclick="slicc.lick({action:'a'})">A</button><script></script>`,
        'panel-a',
      );
      await rendererB.render(
        `<button id="b" onclick="slicc.lick({action:'b'})">B</button><script></script>`,
        'panel-b',
      );

      const btnA = container.querySelector('#a');
      const btnB = containerB.querySelector('#b');

      expect(btnA?.getAttribute('onclick')).toContain('__slicc_panels["panel-a"]');
      expect(btnB?.getAttribute('onclick')).toContain('__slicc_panels["panel-b"]');
    });
  });
});
