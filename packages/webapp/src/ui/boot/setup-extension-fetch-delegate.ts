import type { FetchProxyRequestMsg, FetchProxyResponseMsg } from '@slicc/shared-ts';
import { createLogger } from '../../core/index.js';
import {
  type ExtensionFetchDelegateRequest,
  isExtensionFetchDelegateRequest,
} from '../llm-proxy-sw-config.js';

const log = createLogger('boot/ext-fetch-delegate');

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
      } satisfies FetchProxyResponseMsg);
    } catch {}
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
      } satisfies FetchProxyResponseMsg);
    } catch {}
    responsePort.close();
    return;
  }

  let terminated = false;
  const finish = (): void => {
    terminated = true;
    try {
      port.disconnect();
    } catch {}
    try {
      responsePort.close();
    } catch {}
  };

  port.onMessage.addListener((raw: unknown) => {
    if (terminated) return;
    const msg = raw as FetchProxyResponseMsg;
    try {
      responsePort.postMessage(msg);
    } catch {}
    if (msg.type === 'response-end' || msg.type === 'response-error') finish();
  });

  port.onDisconnect.addListener(() => {
    if (terminated) return;
    try {
      responsePort.postMessage({
        type: 'response-error',
        error: 'extension-delegate: fetch-proxy port disconnected',
      } satisfies FetchProxyResponseMsg);
    } catch {}
    finish();
  });

  port.postMessage({ type: 'request', ...envelope.request } satisfies FetchProxyRequestMsg);
}

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
