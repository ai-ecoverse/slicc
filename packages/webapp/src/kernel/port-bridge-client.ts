/**
 * Shared factory behind the worker → extension Port bridge clients (EXT7 /
 * EXT8). In the hosted-leader tab / kernel worker the agent realm cannot use
 * the same-extension `chrome.runtime.sendMessage` path (no `chrome.runtime.id`)
 * so worker-realm RPCs are routed to the extension over a named,
 * externally-connectable `chrome.runtime.connect(<delegateId>, { name })` Port,
 * with a fallback panel-RPC leg for realms that have no `chrome` at all.
 *
 * Every call site owns the same skeleton — cached Port + monotonically
 * increasing `id` + `pending` Map + `handleMessage` / `handleDisconnect` /
 * `openPort` — parameterized only by (a) the Port name, (b) the panel-RPC op,
 * (c) the timeout, (d) whether an unavailable transport resolves undefined or
 * rejects, (e) the error constructor for reject-mode, and (f) the request /
 * reply shape builders. This module owns the skeleton; the specializations
 * (`secrets-bridge-client`, `mount-bridge-client`) own their per-call-site
 * policy.
 *
 * The panel-RPC bridge always reads `{ response }` from the client result —
 * see `PanelRpcResponses` in `panel-rpc.ts`.
 */

import { createLogger } from '../core/logger.js';
import { getExtensionDelegateId } from '../shell/proxied-fetch.js';
import type { PanelRpcOp } from './panel-rpc.js';

/** Minimal structural view of the explicit-id `chrome.runtime` Port. */
interface BridgePort {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}

interface ChromeRuntimeConnect {
  connect: (extensionId: string, info: { name: string }) => BridgePort;
}

interface PendingCall<TReply> {
  resolve: (value: TReply) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Per-call-site configuration for `createPortBridgeClient`. */
export interface PortBridgeOptions<TRequest> {
  /** Named `chrome.runtime.connect` Port (e.g. `'secrets.crud'`). */
  portName: string;
  /** Panel-RPC op key used from a chrome-less realm (e.g. `'secrets-bridge'`). */
  panelRpcOp: PanelRpcOp;
  /** Per-call timeout for both transports. */
  timeoutMs: number;
  /**
   * Whether an unavailable transport (no delegate id, no `chrome`, no
   * panel-RPC client, timeout, or disconnect) resolves `undefined` or rejects.
   */
  onUnavailable: 'resolve-undefined' | 'reject';
  /** Error constructor for reject-mode (unavailable / timeout / disconnect / post throw). */
  makeError: (message: string) => Error;
  /** Logger namespace (also embedded in default log messages). */
  logNamespace: string;
  /** Encode a `TRequest` as the message body posted on the Port (id is added by the factory). */
  toPortMessage: (request: TRequest) => Record<string, unknown>;
  /** Encode a `TRequest` as the panel-RPC payload for the worker-realm fallback. */
  toPanelRpcPayload: (request: TRequest) => Record<string, unknown>;
}

/**
 * Build a Port-bridge client function. The returned function is realm-aware:
 *
 *   a. PAGE realm (`chrome.runtime.connect` present): direct Port path.
 *   b. WORKER realm (no `chrome`, delegate id set): panel-RPC fallback.
 *   c. Otherwise: unavailable — resolves `undefined` or rejects per `onUnavailable`.
 */
export function createPortBridgeClient<TRequest, TReply>(
  opts: PortBridgeOptions<TRequest>
): (request: TRequest) => Promise<TReply | undefined> {
  const log = createLogger(opts.logNamespace);
  let cachedPort: BridgePort | null = null;
  let nextId = 1;
  const pending = new Map<number, PendingCall<TReply>>();

  function handleMessage(raw: unknown): void {
    const msg = raw as { id?: number; response?: unknown };
    if (typeof msg?.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg.response as TReply);
  }

  function handleDisconnect(): void {
    cachedPort = null;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(opts.makeError(`${opts.portName} port disconnected`));
    }
    pending.clear();
    log.debug(`${opts.portName} port disconnected; pending cleared, will reconnect`);
  }

  function openPort(): BridgePort | null {
    if (cachedPort) return cachedPort;
    const id = getExtensionDelegateId();
    if (!id) {
      log.warn(`cannot open ${opts.portName} port: no extension delegate id`);
      return null;
    }
    if (typeof chrome === 'undefined' || typeof chrome?.runtime?.connect !== 'function') {
      log.warn(`cannot open ${opts.portName} port: chrome.runtime.connect unavailable`);
      return null;
    }
    const connect = (chrome.runtime as unknown as ChromeRuntimeConnect).connect;
    const port = connect(id, { name: opts.portName });
    port.onMessage.addListener(handleMessage);
    port.onDisconnect.addListener(handleDisconnect);
    cachedPort = port;
    return port;
  }

  function unavailable(message: string): Promise<TReply | undefined> {
    if (opts.onUnavailable === 'resolve-undefined') return Promise.resolve(undefined);
    return Promise.reject(opts.makeError(message));
  }

  function callViaPort(request: TRequest): Promise<TReply | undefined> {
    return new Promise<TReply | undefined>((resolve, reject) => {
      const port = openPort();
      if (!port) {
        void unavailable(`${opts.portName} transport unavailable`).then(resolve, reject);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          log.warn(`${opts.portName} call timed out`);
          void unavailable(`${opts.portName} call timed out`).then(resolve, reject);
        }
      }, opts.timeoutMs);
      pending.set(id, { resolve: resolve as (value: TReply) => void, reject, timer });
      try {
        port.postMessage({ id, ...opts.toPortMessage(request) });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        cachedPort = null;
        reject(opts.makeError(err instanceof Error ? err.message : String(err)));
      }
    });
  }

  async function callViaPanelRpc(request: TRequest): Promise<TReply | undefined> {
    const { getPanelRpcClient } = await import('./panel-rpc.js');
    const client = getPanelRpcClient();
    if (!client) {
      log.warn(`cannot bridge ${opts.portName} call: panel-RPC client unavailable`);
      return unavailable(`${opts.portName} transport: panel-RPC client unavailable`);
    }
    const result = (await client.call(opts.panelRpcOp, opts.toPanelRpcPayload(request), {
      timeoutMs: opts.timeoutMs,
    })) as { response: TReply };
    return result.response;
  }

  return (request: TRequest): Promise<TReply | undefined> => {
    if (typeof chrome === 'undefined' && getExtensionDelegateId()) {
      return callViaPanelRpc(request);
    }
    return callViaPort(request);
  };
}
