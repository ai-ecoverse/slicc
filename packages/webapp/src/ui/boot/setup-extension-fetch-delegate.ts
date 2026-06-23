/**
 * Page-side half of extension-delegate fetch mode (see
 * `llm-proxy-sw-config.ts` for the architecture note).
 *
 * The pinned hosted leader tab is the only realm in the chain that can reach
 * `chrome.runtime` — the LLM-proxy SW (web origin) cannot, and the kernel
 * DedicatedWorker has no extension API. So the SW delegates each cross-origin
 * fetch to this listener: it opens
 * `chrome.runtime.connect(<extensionId>, { name: 'fetch-proxy.fetch' })`,
 * forwards the request, and pipes every inbound `ResponseMsg` straight back to
 * the SW-supplied `MessagePort` as it arrives (no buffering — streaming SSE
 * stays intact). The chrome Port maps 1:1 to the SW's `MessageChannel`.
 */

import type {
  RequestMsg,
  ResponseMsg,
} from '../../../../chrome-extension/src/fetch-proxy-shared.js';
import { createLogger } from '../../core/index.js';
import {
  type ExtensionFetchDelegateRequest,
  isExtensionFetchDelegateRequest,
} from '../llm-proxy-sw-config.js';

const log = createLogger('boot/ext-fetch-delegate');

/** Minimal structural view of the chrome runtime Port we open to the extension. */
interface ChromeFetchPort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

interface ChromeRuntimeLike {
  connect: (extensionId: string, info: { name: string }) => ChromeFetchPort;
}

function getChromeRuntime(): ChromeRuntimeLike | null {
  const runtime = (globalThis as { chrome?: { runtime?: Partial<ChromeRuntimeLike> } }).chrome
    ?.runtime;
  return runtime && typeof runtime.connect === 'function' ? (runtime as ChromeRuntimeLike) : null;
}

/**
 * Drive one delegated fetch: connect to the extension, post the request, and
 * mirror each `ResponseMsg` onto the SW-supplied response port. Forwards a
 * synthetic `response-error` if the chrome Port disconnects before the stream
 * terminates so the SW's consumer never hangs.
 */
function runDelegatedFetch(
  envelope: ExtensionFetchDelegateRequest,
  responsePort: MessagePort,
  fallbackExtensionId: string
): void {
  const runtime = getChromeRuntime();
  if (!runtime) {
    try {
      responsePort.postMessage({
        type: 'response-error',
        error: 'extension-delegate: chrome.runtime.connect unavailable',
      } satisfies ResponseMsg);
    } catch {
      /* port may already be gone */
    }
    responsePort.close();
    return;
  }

  const extensionId = envelope.extensionId || fallbackExtensionId;
  let port: ChromeFetchPort;
  try {
    port = runtime.connect(extensionId, { name: 'fetch-proxy.fetch' });
  } catch (err) {
    try {
      responsePort.postMessage({
        type: 'response-error',
        error: `extension-delegate: connect failed — ${err instanceof Error ? err.message : String(err)}`,
      } satisfies ResponseMsg);
    } catch {
      /* port may already be gone */
    }
    responsePort.close();
    return;
  }

  let terminated = false;
  const finish = (): void => {
    terminated = true;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    try {
      responsePort.close();
    } catch {
      /* already closed */
    }
  };

  port.onMessage.addListener((raw: unknown) => {
    if (terminated) return;
    const msg = raw as ResponseMsg;
    try {
      responsePort.postMessage(msg);
    } catch {
      /* SW-side channel gone — drop */
    }
    if (msg.type === 'response-end' || msg.type === 'response-error') finish();
  });

  port.onDisconnect.addListener(() => {
    if (terminated) return;
    try {
      responsePort.postMessage({
        type: 'response-error',
        error: 'extension-delegate: fetch-proxy port disconnected',
      } satisfies ResponseMsg);
    } catch {
      /* already gone */
    }
    finish();
  });

  // Re-add the `request` discriminator the SW stripped before delegating.
  port.postMessage({ type: 'request', ...envelope.request } satisfies RequestMsg);
}

/**
 * Install the SW → page delegated-fetch listener. Idempotent per call site;
 * call once during boot BEFORE the kernel worker starts so the first LLM
 * fetch can be served. No-op when there is no `navigator.serviceWorker`.
 */
export function installExtensionFetchDelegate(extensionId: string): void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    if (!isExtensionFetchDelegateRequest(event.data)) return;
    const responsePort = event.ports?.[0];
    if (!responsePort) {
      log.warn('delegated fetch envelope arrived without a response port');
      return;
    }
    runDelegatedFetch(event.data, responsePort, extensionId);
  });
}
