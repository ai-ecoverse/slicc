/**
 * Tool UI host — parallel to dip hydration.
 *
 * Queries [data-tool-ui-id] containers inside a rendered message host,
 * creates a sandboxed iframe per container, renders the approval card
 * HTML from `toolUIHtmlStore`, and routes picker gestures (directory /
 * usb / serial / hid) back to the worker via onAction.
 *
 * Extension: iframe.src = chrome.runtime.getURL('tool-ui-sandbox.html')
 * Standalone: iframe.srcdoc = TOOL_UI_SANDBOX_SRCDOC
 */

import { handleDipPickerAction } from './dip.js';
import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight } from './theme.js';
import { TOOL_UI_SANDBOX_SRCDOC } from './tool-ui-sandbox-srcdoc.js';
import { toolUIHtmlStore } from './wc/wc-message-view.js';

const isExtensionEnv =
  typeof chrome !== 'undefined' && !!(chrome as { runtime?: { id?: string } })?.runtime?.id;

export interface ToolUIInstance {
  dispose(): void;
}

export interface ToolUIHostOptions {
  isExtension?: boolean;
  /** Called when the user's action result is ready to send back to the worker. */
  onAction: (requestId: string, action: string, data?: unknown) => void;
}

export function hydrateToolUI(host: HTMLElement, opts: ToolUIHostOptions): ToolUIInstance[] {
  const ext = opts.isExtension ?? isExtensionEnv;
  // Check the host itself (when the container IS the top-level element in els)
  // and all descendants (legacy/fallback path).
  const containers: HTMLElement[] = [];
  if (host.hasAttribute('data-tool-ui-id')) containers.push(host);
  containers.push(...host.querySelectorAll<HTMLElement>('[data-tool-ui-id]'));
  const instances: ToolUIInstance[] = [];

  for (const container of containers) {
    const requestId = container.getAttribute('data-tool-ui-id') ?? '';
    const html = toolUIHtmlStore.get(requestId) ?? '';
    instances.push(mountToolUI(container, requestId, html, ext, opts.onAction));
  }

  return instances;
}

export function disposeToolUIs(instances: ToolUIInstance[] | undefined): void {
  if (!instances) return;
  for (const inst of instances) {
    try {
      inst.dispose();
    } catch {
      /* best-effort */
    }
  }
  instances.length = 0;
}

async function runExtensionPicker(
  picker: string,
  data: unknown,
  requestId: string,
  onAction: (requestId: string, action: string, data?: unknown) => void
): Promise<void> {
  try {
    const { openPickerPopup } = await import('../shell/supplemental-commands/picker-popup.js');
    const dataRec = (data ?? null) as Record<string, unknown> | null;
    const filters = Array.isArray(dataRec?.filters) ? (dataRec!.filters as unknown[]) : [];
    const result = await openPickerPopup(
      picker as import('../shell/supplemental-commands/picker-popup.js').PickerKind,
      filters
    );
    if (result.cancelled) {
      onAction(requestId, 'approve', { cancelled: true });
    } else if (result.error) {
      onAction(requestId, 'approve', { error: result.error });
    } else {
      onAction(requestId, 'approve', result);
    }
  } catch (err: unknown) {
    onAction(requestId, 'approve', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function mountToolUI(
  container: HTMLElement,
  requestId: string,
  html: string,
  isExtension: boolean,
  onAction: (requestId: string, action: string, data?: unknown) => void
): ToolUIInstance {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';

  if (isExtension) {
    iframe.src = (chrome as { runtime: { getURL: (p: string) => string } }).runtime.getURL(
      'tool-ui-sandbox.html'
    );
  } else {
    iframe.srcdoc = TOOL_UI_SANDBOX_SRCDOC;
  }

  let disposed = false;

  const messageHandler = async (event: MessageEvent): Promise<void> => {
    if (disposed) return;
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as {
      type?: string;
      id?: string;
      action?: string;
      data?: unknown;
      picker?: string;
      nonce?: string;
    };
    if (msg?.type !== 'tool-ui-action') return;
    if (msg.id !== requestId) return;

    const action = msg.action ?? 'deny';

    if (action === 'deny' || !msg.picker) {
      onAction(requestId, action, msg.data);
      return;
    }

    if (isExtension) {
      await runExtensionPicker(msg.picker, msg.data, requestId, onAction);
    } else {
      await handleDipPickerAction(
        { type: 'tool-ui-action', action, data: msg.data, picker: msg.picker },
        (lickAction, lickData) => onAction(requestId, lickAction, lickData)
      );
    }
  };

  window.addEventListener('message', messageHandler);

  const sendRender = (): void => {
    iframe.contentWindow?.postMessage(
      {
        type: 'tool-ui-render',
        id: requestId,
        nonce: Math.random().toString(36).slice(2),
        html,
        themeCSS: collectThemeCSS(),
        isLight: isThemeLight(),
      },
      '*'
    );
  };
  iframe.addEventListener('load', sendRender, { once: true });

  const resizeHandler = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data as { type?: string; height?: number };
    if ((msg?.type === 'tool-ui-rendered' || msg?.type === 'tool-ui-resize') && msg.height) {
      iframe.style.height = `${msg.height}px`;
    }
  };
  window.addEventListener('message', resizeHandler);

  container.appendChild(iframe);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', messageHandler);
      window.removeEventListener('message', resizeHandler);
      iframe.remove();
      toolUIHtmlStore.delete(requestId);
    },
  };
}
