/**
 * Bridge client for the `secrets.crud` Port (EXT7, thin-extension topology).
 *
 * In the hosted-leader tab / kernel worker the agent realm cannot use the
 * same-extension `chrome.runtime.sendMessage` path (no `chrome.runtime.id`), so
 * secret-CRUD / feed / scrub control messages are routed to the extension over
 * an externally-connectable `chrome.runtime.connect(<delegateId>, { name:
 * 'secrets.crud' })` Port — the SW side mirrors the `fetch-proxy.fetch` handler.
 *
 * The transport skeleton (cached Port, correlation, panel-RPC fallback) lives
 * in `kernel/port-bridge-client.ts`; this file only owns the per-call-site
 * policy: `secrets.crud` Port name, 10s timeout, best-effort semantics (secrets
 * never block boot — unavailable / timeout / no panel-RPC client resolve
 * `undefined`), and the Port message shape `{ id, type, ...payload }`.
 *
 * Payloads are secret-adjacent — only the control `type` is ever logged.
 */

import { createPortBridgeClient } from '../kernel/port-bridge-client.js';

/** Per-call timeout; multi-MB downloads aren't on this path, so 10s is ample. */
const CALL_TIMEOUT_MS = 10_000;

interface SecretsBridgeRequest {
  type: string;
  payload?: Record<string, unknown>;
}

const call = createPortBridgeClient<SecretsBridgeRequest, unknown>({
  portName: 'secrets.crud',
  panelRpcOp: 'secrets-bridge',
  timeoutMs: CALL_TIMEOUT_MS,
  onUnavailable: 'resolve-undefined',
  makeError: (message) => new Error(message),
  logNamespace: 'secrets-bridge',
  toPortMessage: ({ type, payload }) => ({ type, ...payload }),
  toPanelRpcPayload: ({ type, payload }) => ({ type, payload }),
});

/**
 * Dispatch a `secrets.crud` control message and await the correlated reply.
 * Realm-aware — see `createPortBridgeClient`. Resolves with the handler's
 * `response` shape, or `undefined` when the bridge is unavailable or the call
 * times out (best-effort). Rejects only if the Port disconnects mid-flight or
 * `postMessage` throws — the Wave 2 call sites map both to their existing safe
 * defaults.
 */
export function callSecretsBridge<T = unknown>(
  type: string,
  payload?: Record<string, unknown>
): Promise<T> {
  return call({ type, payload }) as Promise<T>;
}
