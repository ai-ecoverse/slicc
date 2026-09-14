import type { CDPPayload } from '@slicc/shared-ts';

import { createLogger } from '../base/logger.js';
import {
  PANEL_RPC_DEFAULT_TIMEOUT_MS,
  type PanelRpcClient,
  type RemoteCdpEventPayload,
} from '../kernel/panel-rpc.js';
import type { CDPTransport } from './transport.js';
import type { CDPEventListener, ConnectionState } from './types.js';

const log = createLogger('panel-rpc-cdp');

const DEFAULT_CDP_TIMEOUT_MS = 30_000;

export const PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS = 5_000;

export class PanelRpcCdpTransport implements CDPTransport {
  private readonly eventListeners = new Map<string, Set<CDPEventListener>>();

  private readonly pendingOnce = new Set<{
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly key: string;
  private _state: ConnectionState = 'connected';
  private pushRegistered = false;

  constructor(
    private readonly getPanelRpc: () => PanelRpcClient | null,
    private readonly runtimeId: string,
    private readonly localTargetId: string,
    private readonly timeoutMs = DEFAULT_CDP_TIMEOUT_MS
  ) {
    this.key = `${runtimeId}:${localTargetId}`;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(): Promise<void> {}

  disconnect(): void {
    this._state = 'disconnected';

    for (const entry of this.pendingOnce) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Transport disconnected'));
    }
    this.pendingOnce.clear();
    const rpc = this.getPanelRpc();
    if (rpc) {
      if (this.pushRegistered) {
        rpc.unregisterPushTarget(this.key);
        this.pushRegistered = false;
      }

      void rpc
        .call('remote-cdp-detach', {
          runtimeId: this.runtimeId,
          localTargetId: this.localTargetId,
        })
        .catch((err) => {
          log.error('remote-cdp detach failed (page-side session may leak)', {
            key: this.key,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    this.eventListeners.clear();
  }

  async send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload> {
    if (this._state === 'disconnected') {
      throw new Error('Transport disconnected');
    }
    const rpc = this.getPanelRpc();
    if (!rpc) {
      throw new Error('cdp: no page bridge to the leader tray (panel-RPC client)');
    }
    const cdpTimeout = timeout ?? this.timeoutMs;
    const timeoutMs =
      Math.max(cdpTimeout, PANEL_RPC_DEFAULT_TIMEOUT_MS) + PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS;
    return rpc.call(
      'remote-cdp-send',
      {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        method,
        params,
        sessionId,

        timeout: cdpTimeout,
      },
      { timeoutMs }
    );
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.eventListeners.get(event);
    const firstForEvent = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(listener);
    if (firstForEvent) this.subscribe(event);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.eventListeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.eventListeners.delete(event);
      this.unsubscribe(event);
    }
  }

  once(event: string, timeout?: number): Promise<CDPPayload> {
    return new Promise((resolve, reject) => {
      const tm = timeout ?? this.timeoutMs;
      const entry = { reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      const cleanup = () => {
        clearTimeout(entry.timer);
        this.pendingOnce.delete(entry);
        this.off(event, handler);
      };
      entry.timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Remote CDP event timed out: ${event}`));
      }, tm);
      const handler = (params: CDPPayload) => {
        cleanup();
        resolve(params);
      };
      this.pendingOnce.add(entry);
      this.on(event, handler);
    });
  }

  private handleEvent(method: string, params: CDPPayload): void {
    const listeners = this.eventListeners.get(method);
    if (!listeners) return;
    for (const cb of [...listeners]) cb(params);
  }

  private ensurePushRegistered(rpc: PanelRpcClient): void {
    if (this.pushRegistered) return;
    rpc.registerPushTarget(this.key, (payload: RemoteCdpEventPayload) =>
      this.handleEvent(payload.method, payload.params ?? {})
    );
    this.pushRegistered = true;
  }

  private subscribe(event: string): void {
    const rpc = this.getPanelRpc();
    if (!rpc) {
      log.error('remote-cdp subscribe skipped: no panel-RPC client', {
        key: this.key,
        event,
      });
      return;
    }
    this.ensurePushRegistered(rpc);
    void rpc
      .call('remote-cdp-subscribe', {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        event,
      })
      .catch((err) => {
        log.error('remote-cdp subscribe failed; events for this transport will not arrive', {
          key: this.key,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private unsubscribe(event: string): void {
    const rpc = this.getPanelRpc();
    if (!rpc) return;
    void rpc
      .call('remote-cdp-unsubscribe', {
        runtimeId: this.runtimeId,
        localTargetId: this.localTargetId,
        event,
      })
      .catch((err) => {
        log.error('remote-cdp unsubscribe failed (page-side forwarder may leak)', {
          key: this.key,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
