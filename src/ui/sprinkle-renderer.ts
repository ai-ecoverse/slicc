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
    iframe.style.cssText = 'width: 100%; height: 100%; border: none;';
    this.iframe = iframe;

    // Wait for iframe to load
    await new Promise<void>((resolve) => {
      iframe.addEventListener('load', () => resolve(), { once: true });
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

    // Send content to the sandbox for rendering
    iframe.contentWindow!.postMessage(
      { type: 'sprinkle-render', content, name: sprinkleName }, '*',
    );
  }

  /** Push an update to the sprinkle (agent -> sprinkle). */
  pushUpdate(data: unknown): void {
    if (this.iframe?.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: 'sprinkle-update', data }, '*');
    }
  }

  /**
   * CLI mode: render directly in the page DOM (no CSP restrictions).
   */
  private renderInline(content: string, sprinkleName: string): void {
    // Ensure the global sprinkle registry exists
    if (!window.__slicc_sprinkles) window.__slicc_sprinkles = {};
    window.__slicc_sprinkles[sprinkleName] = this.bridge;

    // Parse HTML and set content (scripts won't execute via innerHTML).
    // Content is user/agent-authored .shtml — trusted, not external input.
    const wrapper = document.createElement('div');
    wrapper.className = 'sprinkle-content';
    wrapper.innerHTML = content;
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
        const onclickFns = new Set<string>();
        for (const el of wrapper.querySelectorAll('[onclick]')) {
          const attr = el.getAttribute('onclick') || '';
          for (const m of attr.matchAll(/\b(\w+)\s*\(/g)) {
            const name = m[1];
            if (!['slicc', 'bridge', 'lick', 'close'].includes(name)) onclickFns.add(name);
          }
        }
        const hoists = [...onclickFns]
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
    const wrapper = this.container.querySelector('.sprinkle-content');
    if (wrapper) wrapper.remove();
    if (window.__slicc_sprinkles) {
      delete window.__slicc_sprinkles[this.bridge.name];
    }
  }
}
