/**
 * PanelRpcCdpTransport — a `CDPTransport` that tunnels CDP over the
 * panel-RPC BroadcastChannel to a page-side handler which owns the real
 * `RemoteCDPTransport` (the WebRTC data channel to a follower/cherry).
 *
 * Standalone splits the agent + `BrowserAPI` (kernel worker) from the
 * tray + WebRTC channels (page). The worker can't hold an
 * `RTCDataChannel`, so the worker's `BrowserAPI` drives remote targets
 * through this transport instead of a directly-owned `RemoteCDPTransport`.
 *
 * Modeled on `RemoteCDPTransport`: initial `state = 'connected'`,
 * `connect()` is a no-op, and the page-side session is created lazily on
 * the first `send`/`subscribe` for the key. `BrowserAPI.attachToPage()`
 * never calls `connect()` on a remote transport — it goes straight to
 * `createRemoteTransport()` → `send('Target.attachToTarget', …)`.
 */

import { createLogger } from '../core/logger.js';
import {
  PANEL_RPC_DEFAULT_TIMEOUT_MS,
  type PanelRpcClient,
  type RemoteCdpEventPayload,
} from '../kernel/panel-rpc.js';
import type { CDPTransport } from './transport.js';
import type { CDPEventListener, ConnectionState } from './types.js';

const log = createLogger('panel-rpc-cdp');

/** Default CDP send timeout, matching `RemoteCDPTransport`. */
const DEFAULT_CDP_TIMEOUT_MS = 30_000;

/**
 * Headroom added on top of the CDP timeout so the panel-RPC `call()`
 * layer never times out *before* the CDP op it carries. Keeps bridge
 * timeouts from masking the real CDP error.
 */
export const PANEL_RPC_BRIDGE_TIMEOUT_MARGIN_MS = 5_000;

export class PanelRpcCdpTransport implements CDPTransport {
  private readonly eventListeners = new Map<string, Set<CDPEventListener>>();
  /**
   * In-flight `once()` waiters, so `disconnect()` can reject them with a
   * clear `Transport disconnected` (mirroring `RemoteCDPTransport`)
   * instead of letting them hang to their own event timeout.
   */
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

  async connect(): Promise<void> {
    // No-op — the page owns the real transport (data channel). Mirrors
    // RemoteCDPTransport; BrowserAPI never calls connect() on a remote
    // transport. (Fewer params than CDPTransport.connect is fine: an
    // optional trailing arg can be omitted by an implementer.)
  }

  disconnect(): void {
    this._state = 'disconnected';
    // Reject any in-flight once() waiters with a clear cause rather than
    // leaving them to hang to their own event timeout.
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
      // Best-effort page-side teardown — tolerate "page already gone"
      // (e.g. on reload) by not rejecting the caller, but surface a real
      // failure (prod logs gate at ERROR) so a never-wired bridge that
      // leaks the page-side session doesn't fail silently.
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
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout?: number
  ): Promise<Record<string, unknown>> {
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
        // Forward the resolved CDP timeout so the page-side transport
        // honors it instead of flooring at its own 30s default. The
        // panel-RPC `timeoutMs` above is layered strictly higher, so the
        // real CDP error surfaces before the bridge call times out.
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

  once(event: string, timeout?: number): Promise<Record<string, unknown>> {
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
      const handler = (params: Record<string, unknown>) => {
        cleanup();
        resolve(params);
      };
      this.pendingOnce.add(entry);
      this.on(event, handler);
    });
  }

  /** Dispatch a page-pushed CDP event to local listeners. */
  private handleEvent(method: string, params: Record<string, unknown>): void {
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
      // Fail-closed: events can't arrive without a bridge. Surface it —
      // a silently-skipped subscribe would otherwise present as a caller
      // (e.g. `navigate`'s `once`) hanging to its event timeout.
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
        // Don't reject the caller's on()/once() synchronously, but don't
        // swallow either: a failed subscribe means events for this event
        // never arrive, surfacing as a misleading event-timeout later.
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
        // A failed unsubscribe leaks a page-side forwarder ref-count;
        // surface it instead of swallowing.
        log.error('remote-cdp unsubscribe failed (page-side forwarder may leak)', {
          key: this.key,
          event,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}
