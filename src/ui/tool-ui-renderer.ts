/**
 * Tool UI Renderer — renders tool UI elements in the chat.
 *
 * Similar to SprinkleRenderer but simpler — focused on one-shot
 * interactions rather than persistent sprinkle state.
 *
 * In extension mode, renders inside a sandbox iframe (CSP-exempt).
 * In CLI mode, renders directly in the DOM.
 */

import { toolUIRegistry } from '../tools/tool-ui.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool-ui-renderer');

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export class ToolUIRenderer {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private requestId: string;

  constructor(container: HTMLElement, requestId: string) {
    this.container = container;
    this.requestId = requestId;
  }

  /** Render HTML content */
  async render(html: string): Promise<void> {
    if (isExtension) {
      await this.renderInSandbox(html);
    } else {
      this.renderInline(html);
    }
  }

  /** Extension mode: render inside sandbox iframe */
  private async renderInSandbox(html: string): Promise<void> {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('tool-ui-sandbox.html');
    iframe.style.cssText = 'width: 100%; border: none; min-height: 60px;';
    this.iframe = iframe;

    // Wait for iframe to load
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        log.error('Tool UI iframe load timed out');
        // Clean up iframe on timeout
        iframe.remove();
        this.iframe = null;
        reject(new Error('tool-ui sandbox iframe load timed out'));
      }, 5000);

      iframe.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });

      iframe.addEventListener('error', () => {
        clearTimeout(timer);
        // Clean up iframe on error
        iframe.remove();
        this.iframe = null;
        reject(new Error('tool-ui sandbox iframe failed to load'));
      }, { once: true });

      this.container.appendChild(iframe);
    });

    // Listen for messages from the sandbox
    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg?.type) return;

      if (msg.type === 'tool-ui-action' && msg.id === this.requestId) {
        log.info('Tool UI action received', { id: msg.id, action: msg.action });
        toolUIRegistry.handleAction(msg.id, {
          action: msg.action,
          data: msg.data,
        });
      } else if (msg.type === 'tool-ui-rendered' && msg.id === this.requestId) {
        log.info('Tool UI rendered in sandbox', { id: msg.id });
        // Auto-resize iframe based on content
        this.resizeIframe();
      }
    };
    window.addEventListener('message', this.messageHandler);

    const themeCSS = this.collectThemeCSS();

    // Send content to sandbox
    iframe.contentWindow!.postMessage({
      type: 'tool-ui-render',
      id: this.requestId,
      html,
      themeCSS,
    }, '*');
  }

  /** CLI mode: render directly in DOM */
  private renderInline(html: string): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'tool-ui-content';
    // Inject default styles if not already present
    if (!document.getElementById('tool-ui-styles')) {
      const style = document.createElement('style');
      style.id = 'tool-ui-styles';
      style.textContent = `
        .tool-call__ui {
          margin-top: 8px;
        }
        .tool-ui-content {
          padding: 12px;
          background: var(--bg-secondary, #1e1e1e);
          border-radius: 8px;
          border: 1px solid var(--border-color, #333);
        }
        .tool-ui-content .tool-ui {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          color: var(--text-primary, #e0e0e0);
        }
        .tool-ui-content .tool-ui p {
          margin: 0 0 12px 0;
        }
        .tool-ui-content .tool-ui code {
          background: var(--bg-tertiary, #2a2a2a);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
        }
        .tool-ui-content .tool-ui__actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
        }
        .tool-ui-content .tool-ui__btn {
          padding: 8px 16px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }
        .tool-ui-content .tool-ui__btn--primary {
          background: var(--accent-color, #4a9eff);
          color: white;
        }
        .tool-ui-content .tool-ui__btn--primary:hover {
          background: var(--accent-hover, #3a8eef);
        }
        .tool-ui-content .tool-ui__btn--secondary {
          background: var(--bg-tertiary, #333);
          color: var(--text-primary, #e0e0e0);
        }
        .tool-ui-content .tool-ui__btn--secondary:hover {
          background: var(--bg-hover, #444);
        }
      `;
      document.head.appendChild(style);
    }
    wrapper.innerHTML = html;
    this.container.appendChild(wrapper);

    // Attach click handlers for data-action elements
    wrapper.addEventListener('click', (e) => {
      let target = e.target as HTMLElement | null;
      while (target && target !== wrapper) {
        if (target.dataset?.action) {
          const action = target.dataset.action;
          let data: unknown = target.dataset.actionData;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { /* keep as string */ }
          }

          log.info('Tool UI action (inline)', { id: this.requestId, action });
          toolUIRegistry.handleAction(this.requestId, { action, data });

          e.preventDefault();
          e.stopPropagation();
          return;
        }
        target = target.parentElement;
      }
    });

    // Handle form submissions
    wrapper.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const formData = new FormData(form);
      const data: Record<string, unknown> = {};
      formData.forEach((value, key) => { data[key] = value; });

      const action = form.dataset.action || 'submit';
      log.info('Tool UI form submit (inline)', { id: this.requestId, action });
      toolUIRegistry.handleAction(this.requestId, { action, data });
    });
  }

  /** Collect CSS custom properties from parent page */
  private collectThemeCSS(): string {
    if (typeof getComputedStyle !== 'function') return '';
    const rootStyles = getComputedStyle(document.documentElement);
    const cssVars: string[] = [];

    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule && rule.selectorText === ':root') {
            for (let i = 0; i < rule.style.length; i++) {
              const prop = rule.style[i];
              if (prop.startsWith('--')) {
                cssVars.push(`${prop}: ${rootStyles.getPropertyValue(prop)};`);
              }
            }
          }
        }
      } catch { /* cross-origin sheet, skip */ }
    }

    return cssVars.length > 0 ? `:root { ${cssVars.join(' ')} }` : '';
  }

  /** Auto-resize iframe to fit content */
  private resizeIframe(): void {
    if (!this.iframe?.contentWindow) return;

    // Poll for content height (sandbox doesn't send resize events)
    const checkHeight = () => {
      try {
        // Can't access contentDocument in sandbox, use a fixed reasonable height
        // In production, sandbox could postMessage its scrollHeight
        this.iframe!.style.height = '80px';
      } catch { /* ignore */ }
    };

    setTimeout(checkHeight, 50);
  }

  /** Clean up */
  dispose(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.iframe) {
      this.iframe.remove();
      this.iframe = null;
    }
    const wrapper = this.container.querySelector('.tool-ui-content');
    if (wrapper) wrapper.remove();
  }
}

/** Map of active renderers by request ID */
const activeRenderers = new Map<string, ToolUIRenderer>();

/**
 * Create and show a tool UI in a container element.
 * Returns the renderer for later disposal.
 */
export function createToolUIRenderer(container: HTMLElement, requestId: string, html: string): ToolUIRenderer {
  // Clean up any existing renderer for this ID
  const existing = activeRenderers.get(requestId);
  if (existing) {
    existing.dispose();
  }

  const renderer = new ToolUIRenderer(container, requestId);
  activeRenderers.set(requestId, renderer);

  renderer.render(html).catch((err) => {
    log.error('Failed to render tool UI', { requestId, error: err.message });
  });

  return renderer;
}

/**
 * Dispose a tool UI renderer by ID.
 */
export function disposeToolUIRenderer(requestId: string): void {
  const renderer = activeRenderers.get(requestId);
  if (renderer) {
    renderer.dispose();
    activeRenderers.delete(requestId);
  }
}
