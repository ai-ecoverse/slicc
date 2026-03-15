/**
 * Sprinkle Renderer — loads `.shtml` content from VFS and renders
 * it into a container div. Handles script extraction and re-execution.
 *
 * In extension mode, CSP blocks inline scripts and event handlers.
 * The sprinkle renders inside a sandbox iframe (sprinkle-sandbox.html)
 * which is CSP-exempt. Bridge communication uses postMessage.
 */

import type { SprinkleBridgeAPI } from './sprinkle-bridge.js';

declare global {
  interface Window {
    __slicc_sprinkles?: Record<string, SprinkleBridgeAPI>;
  }
}

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export class SprinkleRenderer {
  private container: HTMLElement;
  private bridge: SprinkleBridgeAPI;
  private scripts: HTMLScriptElement[] = [];
  private iframe: HTMLIFrameElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(container: HTMLElement, bridge: SprinkleBridgeAPI) {
    this.container = container;
    this.bridge = bridge;
  }

  /** Render SHTML content into the container. */
  async render(content: string, sprinkleName: string): Promise<void> {
    this.dispose();

    if (isExtension) {
      await this.renderInSandbox(content, sprinkleName);
    } else {
      this.renderInline(content, sprinkleName);
    }
  }

  /**
   * Extension mode: render inside a sandbox iframe (CSP-exempt).
   * Bridge communication happens via postMessage.
   */
  private async renderInSandbox(content: string, sprinkleName: string): Promise<void> {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
    iframe.style.cssText = 'width: 100%; flex: 1; border: none; min-height: 0;';
    this.iframe = iframe;

    // Wait for iframe to load
    console.log('[sprinkle-renderer] creating sandbox iframe', iframe.src);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error('[sprinkle-renderer] iframe load timed out after 5s');
        reject(new Error('sprinkle sandbox iframe load timed out'));
      }, 5000);
      iframe.addEventListener('load', () => {
        clearTimeout(timer);
        console.log('[sprinkle-renderer] iframe loaded, contentWindow:', !!iframe.contentWindow);
        resolve();
      }, { once: true });
      iframe.addEventListener('error', (e) => {
        clearTimeout(timer);
        console.error('[sprinkle-renderer] iframe error:', e);
        reject(new Error('sprinkle sandbox iframe failed to load'));
      }, { once: true });
      this.container.appendChild(iframe);
    });

    // Listen for messages from the sandbox
    this.messageHandler = (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'sprinkle-lick') {
        this.bridge.lick({ action: msg.action, data: msg.data });
      } else if (msg.type === 'sprinkle-set-state') {
        this.bridge.setState(msg.data);
      } else if (msg.type === 'sprinkle-close') {
        this.bridge.close();
      } else if (msg.type === 'sprinkle-readfile') {
        this.bridge.readFile(msg.path).then(
          (fileContent) => iframe.contentWindow?.postMessage(
            { type: 'sprinkle-readfile-response', id: msg.id, content: fileContent }, '*',
          ),
          (err: unknown) => iframe.contentWindow?.postMessage(
            { type: 'sprinkle-readfile-response', id: msg.id, error: err instanceof Error ? err.message : String(err) }, '*',
          ),
        );
      }
    };
    window.addEventListener('message', this.messageHandler);

    // Collect CSS from parent page to inject into the sandbox iframe:
    // 1. CSS custom properties (theme tokens like --s2-*, --slicc-*)
    // 2. Sprinkle component classes (.sprinkle-card, .sprinkle-stack, etc.)
    const rootStyles = getComputedStyle(document.documentElement);
    const cssVars: string[] = [];
    const sprinkleRules: string[] = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule) {
            if (rule.selectorText === ':root') {
              for (let i = 0; i < rule.style.length; i++) {
                const prop = rule.style[i];
                if (prop.startsWith('--')) {
                  cssVars.push(`${prop}: ${rootStyles.getPropertyValue(prop)};`);
                }
              }
            }
            // Collect all sprinkle component rules
            if (rule.selectorText.includes('.sprinkle-') || rule.selectorText.includes('.fill')) {
              sprinkleRules.push(rule.cssText);
            }
          }
        }
      } catch { /* cross-origin sheet, skip */ }
    }
    const themeCSS = (cssVars.length > 0 ? `:root { ${cssVars.join(' ')} }\n` : '')
      + sprinkleRules.join('\n');

    // Extract custom <style> blocks from sprinkle content so the sandbox can inject them
    const { html: cleanedContent, css: customCSS } = SprinkleRenderer.extractStyles(content);

    // Send content to the sandbox for rendering, including saved state
    const savedState = this.bridge.getState();
    iframe.contentWindow!.postMessage(
      { type: 'sprinkle-render', content: cleanedContent, name: sprinkleName, themeCSS, customCSS, savedState }, '*',
    );
  }

  /** Push an update to the sprinkle (agent -> sprinkle). */
  pushUpdate(data: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: 'sprinkle-update', data }, '*');
    }
  }

  /**
   * Extract all function names declared in a script body.
   * Matches `function foo(`, `var foo = function`, `var foo = (` (arrow), `let/const` variants.
   */
  private static extractDeclaredFunctions(scriptText: string): Set<string> {
    const fns = new Set<string>();
    // function declarations: function foo(
    for (const m of scriptText.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
      fns.add(m[1]);
    }
    // var/let/const assignments to functions or arrows: var foo = function / var foo = (
    for (const m of scriptText.matchAll(/\b(?:var|let|const)\s+(\w+)\s*=\s*(?:function\b|\()/g)) {
      fns.add(m[1]);
    }
    // Exclude common false positives
    for (const name of ['if', 'for', 'while', 'switch', 'catch', 'return']) {
      fns.delete(name);
    }
    return fns;
  }

  /**
   * Extract `<style>` blocks from sprinkle HTML and return them separately.
   * This allows scoped custom CSS to work in both CLI and extension modes.
   */
  private static extractStyles(content: string): { html: string; css: string } {
    const styleBlocks: string[] = [];
    const html = content.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_match, css) => {
      styleBlocks.push(css);
      return '';
    });
    return { html, css: styleBlocks.join('\n') };
  }

  /**
   * CLI mode: render directly in the page DOM (no CSP restrictions).
   */
  private renderInline(content: string, sprinkleName: string): void {
    // Ensure the global sprinkle registry exists
    if (!window.__slicc_sprinkles) window.__slicc_sprinkles = {};
    window.__slicc_sprinkles[sprinkleName] = this.bridge;

    // Extract custom <style> blocks and inject them scoped to this sprinkle
    const { html: cleanedHtml, css: customCSS } = SprinkleRenderer.extractStyles(content);
    if (customCSS) {
      const style = document.createElement('style');
      style.dataset.sprinkle = sprinkleName;
      style.textContent = customCSS;
      this.container.appendChild(style);
    }

    // Parse HTML and set content (scripts won't execute via innerHTML).
    // Content is user/agent-authored .shtml — trusted, not external input.
    const wrapper = document.createElement('div');
    wrapper.className = 'sprinkle-content';
    wrapper.innerHTML = cleanedHtml;
    this.container.appendChild(wrapper);

    // Auto-set width on .fill elements from data-value attribute
    for (const fill of wrapper.querySelectorAll<HTMLElement>('.fill[data-value]')) {
      const v = parseFloat(fill.dataset.value || '0');
      if (v >= 0 && v <= 100) fill.style.width = `${v}%`;
    }

    // Rewrite onclick `slicc` or `bridge` references to use the sprinkle-specific bridge.
    const bridgeExpr = `window.__slicc_sprinkles[${JSON.stringify(sprinkleName)}]`;
    for (const el of wrapper.querySelectorAll('[onclick]')) {
      const attr = el.getAttribute('onclick') || '';
      if (/\b(slicc|bridge)\b/.test(attr)) {
        el.setAttribute('onclick', attr.replace(/\b(slicc|bridge)\b/g, bridgeExpr));
      }
    }

    // Extract <script> tags and re-create them as live elements.
    const deadScripts = Array.from(wrapper.querySelectorAll('script'));
    for (const dead of deadScripts) {
      dead.remove();
      const live = document.createElement('script');
      for (const attr of dead.attributes) {
        live.setAttribute(attr.name, attr.value);
      }
      if (!dead.src) {
        // Collect functions from onclick attributes (for backward compatibility)
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
            const name = m[1];
            if (!['slicc', 'bridge', 'lick', 'close'].includes(name)) onclickFns.add(name);
          }
        }

        // Auto-hoist ALL declared functions from the script body
        const declaredFns = SprinkleRenderer.extractDeclaredFunctions(dead.textContent || '');
        const allFns = new Set([...onclickFns, ...declaredFns]);
        // Never hoist internal/private names (underscore prefix)
        for (const fn of allFns) {
          if (fn.startsWith('_')) allFns.delete(fn);
        }
        const hoists = [...allFns]
          .map(fn => `if (typeof ${fn} === 'function') window.${fn} = ${fn};`)
          .join('\n');

        live.textContent =
          `(function() { var slicc = ${bridgeExpr}; var bridge = slicc;\n` +
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
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    for (const script of this.scripts) {
      script.remove();
    }
    this.scripts = [];
    // Remove custom style blocks injected for this sprinkle
    const customStyle = this.container.querySelector('style[data-sprinkle]');
    if (customStyle) customStyle.remove();
    const wrapper = this.container.querySelector('.sprinkle-content');
    if (wrapper) wrapper.remove();
    if (window.__slicc_sprinkles) {
      delete window.__slicc_sprinkles[this.bridge.name];
    }
  }
}
