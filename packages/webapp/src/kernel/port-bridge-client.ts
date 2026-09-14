import { createLogger } from '../base/logger.js';
import { getExtensionDelegateId } from '../shell/proxied-fetch.js';
import type { PanelRpcOp } from './panel-rpc.js';

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

export interface PortBridgeOptions<
  TRequest,
  TPortMessage extends object = object,
  TPanelPayload extends object = object,
> {
  portName: string;

  panelRpcOp: PanelRpcOp;

  timeoutMs: number;

  onUnavailable: 'resolve-undefined' | 'reject';

  makeError: (message: string) => Error;

  logNamespace: string;

  toPortMessage: (request: TRequest) => TPortMessage;

  toPanelRpcPayload: (request: TRequest) => TPanelPayload;
}

export function createPortBridgeClient<
  TRequest,
  TReply,
  TPortMessage extends object = object,
  TPanelPayload extends object = object,
>(
  opts: PortBridgeOptions<TRequest, TPortMessage, TPanelPayload>
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
