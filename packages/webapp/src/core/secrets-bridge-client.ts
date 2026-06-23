/**
 * Bridge client for the `secrets.crud` Port (EXT7, thin-extension topology).
 *
 * In the hosted-leader tab / kernel worker the agent realm cannot use the
 * same-extension `chrome.runtime.sendMessage` path (no `chrome.runtime.id`), so
 * secret-CRUD / feed / scrub control messages are routed to the extension over
 * an externally-connectable `chrome.runtime.connect(<delegateId>, { name:
 * 'secrets.crud' })` Port — the SW side mirrors the `fetch-proxy.fetch` handler.
 *
 * The Port is opened lazily and cached for the session; replies are correlated
 * by a monotonically increasing `id`. Each call has a bounded timeout that
 * resolves to `undefined` (best-effort: secrets never block boot). On
 * `onDisconnect` (e.g. MV3 SW eviction mid-session) the cached Port is cleared
 * and every pending call rejected, so the next call transparently reconnects.
 *
 * Payloads are secret-adjacent — only the control `type` is ever logged.
 */

import { getExtensionDelegateId } from '../shell/proxied-fetch.js';
import { createLogger } from './logger.js';

const log = createLogger('secrets-bridge');

/** Per-call timeout; multi-MB downloads aren't on this path, so 10s is ample. */
const CALL_TIMEOUT_MS = 10_000;

/** Minimal structural view of the explicit-id `chrome.runtime` Port. */
interface SecretsBridgePort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

interface ChromeRuntimeConnect {
  connect: (extensionId: string, info: { name: string }) => SecretsBridgePort;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

let cachedPort: SecretsBridgePort | null = null;
let nextId = 1;
const pending = new Map<number, PendingCall>();

function handleMessage(raw: unknown): void {
  const msg = raw as { id?: number; response?: unknown };
  if (typeof msg?.id !== 'number') return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  entry.resolve(msg.response);
}

function handleDisconnect(): void {
  cachedPort = null;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error('secrets.crud port disconnected'));
  }
  pending.clear();
  log.debug('secrets.crud port disconnected; pending cleared, will reconnect');
}

/** Open (or reuse) the cached `secrets.crud` Port; `null` if unavailable. */
function openPort(): SecretsBridgePort | null {
  if (cachedPort) return cachedPort;
  const id = getExtensionDelegateId();
  if (!id) {
    log.warn('cannot open secrets.crud port: no extension delegate id');
    return null;
  }
  if (typeof chrome === 'undefined' || typeof chrome?.runtime?.connect !== 'function') {
    log.warn('cannot open secrets.crud port: chrome.runtime.connect unavailable');
    return null;
  }
  const connect = (chrome.runtime as unknown as ChromeRuntimeConnect).connect;
  const port = connect(id, { name: 'secrets.crud' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);
  cachedPort = port;
  return port;
}

/**
 * Dispatch a `secrets.crud` control message and await the correlated reply.
 *
 * `type` is one of the SW's `SECRETS_HANDLERS` keys; `payload` is spread into
 * the message. Resolves with the handler's `response` shape, or `undefined`
 * when the Port is unavailable or the call times out (best-effort). Rejects
 * only if the Port disconnects mid-flight or `postMessage` throws — the Wave 2
 * call sites map both to their existing safe defaults.
 */
export function callSecretsBridge<T = unknown>(
  type: string,
  payload?: Record<string, unknown>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const port = openPort();
    if (!port) {
      resolve(undefined as T);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        log.warn('secrets.crud call timed out', { type });
        resolve(undefined as T);
      }
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      port.postMessage({ id, type, ...payload });
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      cachedPort = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
