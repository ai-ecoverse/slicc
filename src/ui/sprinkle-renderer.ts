/**
 * Sprinkle Renderer — loads `.shtml` content from VFS and renders
 * it into a container div. Handles script extraction and re-execution.
 */

import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';

declare global {
  interface Window {
    __slicc_sprinkles?: Record<string, SprinkleBridgeAPI>;
  }
}

export class SprinkleRenderer {
  private container: HTMLElement;
  private bridge: SprinkleBridgeAPI;
  private scripts: HTMLScriptElement[] = [];

  constructor(container: HTMLElement, bridge: SprinkleBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  /** Render SHTML content into the container. */
  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();

    // Ensure the global sprinkle registry exists
    if (!window.__slicc_sprinkles) window.__slicc_sprinkles = {};
    window.__slicc_sprinkles[sprinkleName] = this.bridge;

    // Parse HTML and set content (scripts won't execute via innerHTML)
    const wrapper = document.createElement('div');
    wrapper.className = 'sprinkle-content';
    wrapper.innerHTML = content;
    this.container.appendChild(wrapper);

    // Auto-set width on .fill elements from data-value attribute
    // so agents can write <div class="fill" data-value="75"> instead of inline style
    for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
      const v = parseFloat(fill.dataset.value || '0');
      if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
    }

    // Rewrite onclick `slicc` or `bridge` references to use the sprinkle-specific bridge.
    // This must run before script extraction so it applies even to sprinkles with no scripts.
    const bridgeExpr = `window.__slicc_sprinkles[${JSON.stringify(sprinkleName)}]`;
    const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
    // In extension mode, CSP blocks inline event handlers. We convert onclick
    // attributes to data-slicc-onclick and attach listeners via a blob script.
    const onclickBindings: string[] = [];
    let onclickIdx = 0;
    for (const el of wrapper.querySelectorAll('[onclick]')) {
      const attr = el.getAttribute('onclick') || '';
      const rewritten = /\b(slicc|bridge)\b/.test(attr)
        ? attr.replace(/\b(slicc|bridge)\b/g, bridgeExpr)
        : attr;
      if (isExtension) {
        const id = `_slicc_oc_${onclickIdx++}`;
        el.removeAttribute('onclick');
        el.setAttribute('data-slicc-onclick', id);
        onclickBindings.push(`document.querySelector('[data-slicc-onclick="${id}"]')?.addEventListener('click', function() { ${rewritten} });`);
      } else {
        el.setAttribute('onclick', rewritten);
      }
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
      if (!dead.src) {
        // Collect all function names referenced by onclick attributes in the sprinkle
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          // Match all function calls, not just the first one at position 0
          for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
            const name = m[1];
            // Skip known non-user functions (typeof check in hoist handles the rest)
            if (!['slicc', 'bridge', 'lick', 'close'].includes(name)) onclickFns.add(name);
          }
        }
        const hoists = [...onclickFns]
          .map(fn => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
          .join('\n');

        const code =
          `(function() { var slicc = ${bridgeExpr}; var bridge = slicc;\n` +
          dead.textContent +
          (hoists ? '\n' + hoists : '') +
          '\n})();';

        // In extension mode, CSP blocks inline scripts. Use a blob URL instead
        // (blob: from the same extension origin is treated as 'self').
        if (isExtension) {
          const blob = new Blob([code], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          live.src = blobUrl;
          // Clean up blob URL after script loads
          live.onload = () => URL.revokeObjectURL(blobUrl);
          live.onerror = () => URL.revokeObjectURL(blobUrl);
        } else {
          live.textContent = code;
        }
      }
      wrapper.appendChild(live);
      this.scripts.push(live);
    }

    // In extension mode, add a blob script to bind onclick handlers
    // (inline event handlers are blocked by CSP).
    if (isExtension && onclickBindings.length > 0) {
      const bindScript = document.createElement('script');
      const bindCode = onclickBindings.join('\n');
      const blob = new Blob([bindCode], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      bindScript.src = blobUrl;
      bindScript.onload = () => URL.revokeObjectURL(blobUrl);
      bindScript.onerror = () => URL.revokeObjectURL(blobUrl);
      wrapper.appendChild(bindScript);
      this.scripts.push(bindScript);
    }
  }

  /** Clean up scripts and content. */
  dispose(): void {
    for (const script of this.scripts) {
      script.remove();
    }
    this.scripts = [];
    // Remove sprinkle content
    const wrapper = this.container.querySelector('.sprinkle-content');
    if (wrapper) wrapper.remove();
    // Clean up global reference
    if (window.__slicc_sprinkles) {
      delete window.__slicc_sprinkles[this.bridge.name];
    }
  }
}
