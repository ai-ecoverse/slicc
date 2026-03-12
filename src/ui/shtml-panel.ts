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
      // Inject bridge access preamble + original code
      if (!dead.src) {
        live.textContent =
          `(function() { var slicc = window.__slicc_panels[${JSON.stringify(panelName)}];\n` +
          dead.textContent +
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
