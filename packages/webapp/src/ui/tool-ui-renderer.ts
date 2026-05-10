/**
 * Tool UI Renderer — renders tool UI elements in the chat.
 *
 * Uses the dip iframe architecture for consistent rendering.
 * In CLI mode, renders via mountDip (srcdoc iframe with S2 theme).
 * In extension mode, renders inside a sandbox iframe (CSP-exempt).
 *
 * Supports both slicc.lick() (dip bridge) and data-action
 * attributes (Tool UI blocking pattern). When a lick event fires, it's
 * forwarded to the toolUIRegistry so sprinkle-chat can resolve.
 */

import { toolUIRegistry } from '../tools/tool-ui.js';
import { mountDip, type DipInstance } from './dip.js';
import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight } from './theme.js';
import { createLogger } from '../core/logger.js';
import { openMountPickerPopup } from '../fs/mount-picker-popup.js';

const log = createLogger('tool-ui-renderer');

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

export class ToolUIRenderer {
  private container: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private dip: DipInstance | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private requestId: string;
  private nonce: string;

  constructor(container: HTMLElement, requestId: string) {
    this.container = container;
    this.requestId = requestId;
    this.nonce = crypto.randomUUID();
  }

  /** Render HTML content */
  async render(html: string): Promise<void> {
    if (isExtension) {
      await this.renderInSandbox(html);
    } else {
      this.renderWithDip(html);
    }
  }

  /** Extension mode: render inside sandbox iframe (CSP-exempt) */
  private async renderInSandbox(html: string): Promise<void> {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('tool-ui-sandbox.html');
    iframe.style.cssText = 'width: 100%; border: none; min-height: 60px;';
    this.iframe = iframe;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        log.error('Tool UI iframe load timed out');
        iframe.remove();
        this.iframe = null;
        reject(new Error('tool-ui sandbox iframe load timed out'));
      }, 5000);

      iframe.addEventListener(
        'load',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );

      iframe.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          iframe.remove();
          this.iframe = null;
          reject(new Error('tool-ui sandbox iframe failed to load'));
        },
        { once: true }
      );

      this.container.appendChild(iframe);
    });

    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg?.type) return;
      if (msg.nonce !== this.nonce) {
        log.warn('Tool UI message nonce mismatch', { expected: this.nonce, received: msg.nonce });
        return;
      }

      if (msg.type === 'tool-ui-action' && msg.id === this.requestId) {
        log.info('Tool UI action received', { id: msg.id, action: msg.action });
        this.relayActionToOffscreen(msg.action, msg.data, msg.picker).catch((err: unknown) => {
          log.error('relayActionToOffscreen failed', {
            requestId: this.requestId,
            error: err instanceof Error ? err.message : String(err),
          });
          toolUIRegistry.cancel(this.requestId, 'Relay failed');
        });
      } else if (msg.type === 'tool-ui-rendered' && msg.id === this.requestId) {
        if (msg.height && this.iframe) {
          this.iframe.style.height = `${Math.max(60, msg.height)}px`;
        }
      } else if (msg.type === 'tool-ui-resize' && msg.id === this.requestId) {
        if (msg.height && this.iframe) {
          this.iframe.style.height = `${Math.max(60, msg.height)}px`;
        }
      }
    };
    window.addEventListener('message', this.messageHandler);

    const themeCSS = collectThemeCSS();

    iframe.contentWindow!.postMessage(
      {
        type: 'tool-ui-render',
        id: this.requestId,
        nonce: this.nonce,
        html,
        themeCSS,
        isLight: isThemeLight(),
      },
      '*'
    );
  }

  /**
   * CLI mode: render using dip iframe.
   * Uses the same srcdoc template, S2 theme, and slicc.lick() bridge.
   * Lick events resolve the Tool UI promise via toolUIRegistry.
   *
   * Standalone-worker mode publishes `globalThis.__slicc_tool_ui_send`
   * so the action lands in the worker's registry over the kernel
   * transport instead of the panel-side (empty) registry.
   */
  private renderWithDip(html: string): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    this.container.appendChild(wrapper);

    this.dip = mountDip(wrapper, html, (action, data) => {
      log.info('Tool UI action (dip)', { id: this.requestId, action });
      const send = (
        globalThis as typeof globalThis & {
          __slicc_tool_ui_send?: (requestId: string, action: string, data: unknown) => void;
        }
      ).__slicc_tool_ui_send;
      if (typeof send === 'function') {
        send(this.requestId, action, data);
      } else {
        toolUIRegistry.handleAction(this.requestId, { action, data });
      }
    });
  }

  private async relayActionToOffscreen(
    action: string,
    data: unknown,
    picker?: string
  ): Promise<void> {
    let actionData = data;

    if (picker === 'directory') {
      actionData = await openMountPickerPopup(this.requestId);
    }

    chrome.runtime
      .sendMessage({
        source: 'panel' as const,
        payload: {
          type: 'tool-ui-action' as const,
          requestId: this.requestId,
          action,
          data: actionData,
        },
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Failed to relay tool UI action to offscreen', {
          requestId: this.requestId,
          error: errMsg,
        });
        toolUIRegistry.cancel(this.requestId, `Relay failed: ${errMsg}`);
      });
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
    if (this.dip) {
      this.dip.dispose();
      this.dip = null;
    }
  }
}

/** Map of active renderers by request ID */
const activeRenderers = new Map<string, ToolUIRenderer>();

/**
 * Create and show a tool UI in a container element.
 */
export function createToolUIRenderer(
  container: HTMLElement,
  requestId: string,
  html: string
): ToolUIRenderer {
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
