/**
 * SHTML Panel Renderer — loads `.shtml` content from VFS and renders
 * it into a container div. Handles script extraction and re-execution.
 */

import type { ShtmlBridgeAPI } from './shtml-bridge.js';

declare global {
  interface Window {
    __slicc_panels?: Record<string, ShtmlBridgeAPI>;
  }
}

export class ShtmlPanelRenderer {
  private container: HTMLElement;
  private bridge: ShtmlBridgeAPI;
  private scripts: HTMLScriptElement[] = [];

  constructor(container: HTMLElement, bridge: ShtmlBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  /** Render SHTML content into the container. */
  async render(content: string, panelName: string): Promise<void> {
    this.dispose();

    // Ensure the global panel registry exists
    if (!window.__slicc_panels) window.__slicc_panels = {};
    window.__slicc_panels[panelName] = this.bridge;

    // Parse HTML and set content (scripts won't execute via innerHTML)
    const wrapper = document.createElement('div');
    wrapper.className = 'shtml-panel-content';
    wrapper.innerHTML = content;
    this.container.appendChild(wrapper);

    // Auto-set width on .fill elements from data-value attribute
    // so agents can write <div class="fill" data-value="75"> instead of inline style
    for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
      const v = parseFloat(fill.dataset.value || '0');
      if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
    }

    // Extract <script> tags and re-create them as live elements.
    // Scripts inserted via innerHTML don't execute, so we remove each dead
    // script and append a fresh <script> element to the wrapper.
    const deadScripts = Array.from(wrapper.querySelectorAll('script'));
    for (const dead of deadScripts) {
      dead.remove();
      const live = document.createElement('script');
      // Copy attributes
      for (const attr of dead.attributes) {
        live.setAttribute(attr.name, attr.value);
      }
      // Inject bridge access preamble + original code.
      // Also set window.slicc so onclick attributes (which run in global scope) can use it.
      // Functions called from onclick must be hoisted to window since the script
      // runs inside an IIFE. We detect function names from onclick attributes and
      // append window assignments after the user code.
      if (!dead.src) {
        // Collect function names referenced by onclick attributes in the panel
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          // Match bare function calls like "doThing()" or "doThing(args)"
          const match = attr.match(/^(\w+)\s*\(/);
          if (match && match[1] !== 'slicc') onclickFns.add(match[1]);
        }
        const hoists = [...onclickFns]
          .map(fn => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
          .join('\n');

        live.textContent =
          `(function() { var slicc = window.__slicc_panels[${JSON.stringify(panelName)}]; window.slicc = slicc;\n` +
          dead.textContent +
          (hoists ? '\n' + hoists : '') +
          '\n})();';
      }
      wrapper.appendChild(live);
      this.scripts.push(live);
    }
  }

  /** Clean up scripts and content. */
  dispose(): void {
    for (const script of this.scripts) {
      script.remove();
    }
    this.scripts = [];
    // Remove panel content
    const wrapper = this.container.querySelector('.shtml-panel-content');
    if (wrapper) wrapper.remove();
    // Clean up global reference
    if (window.__slicc_panels) {
      delete window.__slicc_panels[this.bridge.name];
    }
  }
}
