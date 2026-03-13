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
      // Functions called from onclick must be hoisted to window since the script
      // runs inside an IIFE. We detect function names from onclick attributes and
      // append window assignments after the user code.
      // onclick attributes that reference `slicc` are rewritten to use the
      // panel-specific bridge from the registry, avoiding a global collision
      // when multiple panels are open.
      if (!dead.src) {
        // Rewrite onclick `slicc` references to use the panel-specific bridge
        const bridgeExpr = `window.__slicc_panels[${JSON.stringify(panelName)}]`;
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          if (/\bslicc\b/.test(attr)) {
            el.setAttribute('onclick', attr.replace(/\bslicc\b/g, bridgeExpr));
          }
        }

        // Collect all function names referenced by onclick attributes in the panel
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          // Match all function calls, not just the first one at position 0
          for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
            const name = m[1];
            // Skip known non-user functions (typeof check in hoist handles the rest)
            if (name !== 'slicc') onclickFns.add(name);
          }
        }
        const hoists = [...onclickFns]
          .map(fn => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
          .join('\n');

        live.textContent =
          `(function() { var slicc = ${bridgeExpr};\n` +
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
