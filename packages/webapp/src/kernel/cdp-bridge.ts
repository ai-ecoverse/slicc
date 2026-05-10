/**
 * `CdpTransportBridge` — shared base for the proxied `CDPTransport`
 * implementations.
 *
 * Today's `OffscreenCdpProxy` (offscreen → service worker) and
 * `PanelCdpProxy` (panel → offscreen) duplicated ~95% of their bodies:
 *  - pending-command id allocation
 *  - per-command `{resolve, reject, timer}` map
 *  - timeout handling
 *  - listener Map keyed by event method
 *  - `on` / `off` / `once` semantics
 *  - response / event dispatch
 *  - disconnect tear-down
 *
 * The only differences were:
 *  1. The outbound envelope shape (which `source` tag, which payload `type`).
 *  2. The inbound source filter (which envelope `source` to accept).
 *  3. The wire itself (chrome.runtime in extension; MessagePort in the
 *     standalone kernel-worker path).
 *  4. Whether listener errors are logged or swallowed.
 *
 * `CdpTransportBridge` factors out (1)–(4) into `CdpBridgeOptions` so the
 * existing chrome.runtime proxies can extend it (see
 * `cdp/offscreen-cdp-proxy.ts` and `cdp/panel-cdp-proxy.ts`) and a future
 * `cdp-worker-proxy.ts` can reuse the same bridge over a `KernelTransport`.
 *
 * Worker safety: this file uses only timers, `Map`, `Set`, and `Promise`.
 * No DOM, no chrome.* — typechecked under `tsconfig.webapp-worker.json`
 * via `transport.ts` (which is the only ambient type it depends on, and
 * itself a leaf module).
 */

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../cdp/types.js';
import type { CDPTransport } from '../cdp/transport.js';

/** Decoded form of a CDP response, regardless of envelope shape. */
export interface ParsedCdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: string;
}

/** Decoded form of a CDP event, regardless of envelope shape. */
export interface ParsedCdpEvent {
  method: string;
  params?: Record<string, unknown>;
}

export interface CdpBridgeOptions {
  /**
   * Wrap `(id, method, params, sessionId)` into the outbound envelope
   * the wire expects. Result is whatever `sendEnvelope` accepts.
   */
  buildCommandEnvelope: (
    id: number,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ) => unknown;

  /**
   * Send the envelope on the wire. Should reject on transport-level
   * failure; the bridge converts the rejection into a per-command
   * reject. The bridge does NOT retry — that's a responsibility of a
   * higher layer if needed.
   */
  sendEnvelope: (envelope: unknown) => Promise<void>;

  /**
   * Subscribe to inbound envelopes. Returns an unsubscribe function the
   * bridge calls on `disconnect()`.
   */
  subscribeIncoming: (handler: (envelope: unknown) => void) => () => void;

  /**
   * Pluck a CDP response out of an inbound envelope. Returns `null` if
   * the envelope isn't a response (e.g. it's an event, or it's for a
   * different consumer).
   */
  parseResponse: (envelope: unknown) => ParsedCdpResponse | null;

  /**
   * Pluck a CDP event out of an inbound envelope. Returns `null` if the
   * envelope isn't an event.
   */
  parseEvent: (envelope: unknown) => ParsedCdpEvent | null;

  /**
   * Logger for listener exceptions. Today's `OffscreenCdpProxy`
   * silently swallowed errors; `PanelCdpProxy` logged them. Both
   * behaviors are valid; configurable here.
   */
  onListenerError?: (event: string, err: unknown) => void;

  /**
   * Logger for unrecognized response ids. Today's `PanelCdpProxy`
   * console.warns; `OffscreenCdpProxy` silently drops. Optional.
   */
  onUnknownResponseId?: (id: number) => void;

  /**
   * Fired when the FIRST listener is added for a given event method.
   * Used by `WorkerCdpProxy` to send a subscribe message to the
   * page-side forwarder so the page knows which CDP events to relay
   * over the kernel transport. Optional — the chrome.runtime proxies
   * don't need this because the service worker broadcasts every CDP
   * event to every listener.
   */
  onSubscribeEvent?: (event: string) => void;

  /**
   * Fired when the LAST listener is removed for a given event method.
   * Pair with `onSubscribeEvent` for pre-subscribe protocol.
   */
  onUnsubscribeEvent?: (event: string) => void;

  /**
   * Label used in the disconnected-state error. Default
   * `'CDP transport'`.
   */
  label?: string;
}

interface PendingCommand {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpTransportBridge implements CDPTransport {
  private _state: ConnectionState = 'disconnected';
  private nextCommandId = 1;
  private listeners = new Map<string, Set<CDPEventListener>>();
  private pendingCommands = new Map<number, PendingCommand>();
  private unsubscribe: (() => void) | null = null;
  private readonly opts: CdpBridgeOptions;
  private readonly label: string;

  constructor(opts: CdpBridgeOptions) {
    this.opts = opts;
    this.label = opts.label ?? 'CDP transport';
  }

  get state(): ConnectionState {
    return this._state;
  }

  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    this.unsubscribe = this.opts.subscribeIncoming((envelope) => this.handleIncoming(envelope));
    this._state = 'connected';
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${this.label} disconnected`));
    }
    this.pendingCommands.clear();
    this.listeners.clear();
    this._state = 'disconnected';
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') {
      throw new Error(`${this.label} is not connected`);
    }

    const id = this.nextCommandId++;
    const envelope = this.opts.buildCommandEnvelope(id, method, params, sessionId);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(id);
        reject(new Error(`CDP command timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pendingCommands.set(id, {
        resolve: (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        },
        timer,
      });

      this.opts.sendEnvelope(envelope).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(id);
        clearTimeout(timer);
        reject(
          new Error(
            `Failed to send CDP command: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      });
    });
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    const isFirst = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    if (isFirst) {
      this.opts.onSubscribeEvent?.(event);
    }
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.listeners.delete(event);
      this.opts.onUnsubscribeEvent?.(event);
    }
  }

  once(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for event: ${event}`));
      }, timeout);

      const handler: CDPEventListener = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };

      this.on(event, handler);
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private handleIncoming(envelope: unknown): void {
    const response = this.opts.parseResponse(envelope);
    if (response) {
      this.handleResponse(response);
      return;
    }
    const event = this.opts.parseEvent(envelope);
    if (event) {
      this.handleEvent(event);
    }
  }

  private handleResponse(resp: ParsedCdpResponse): void {
    const pending = this.pendingCommands.get(resp.id);
    if (!pending) {
      this.opts.onUnknownResponseId?.(resp.id);
      return;
    }
    this.pendingCommands.delete(resp.id);
    clearTimeout(pending.timer);
    if (resp.error) {
      pending.reject(new Error(resp.error));
    } else {
      pending.resolve(resp.result ?? {});
    }
  }

  private handleEvent(event: ParsedCdpEvent): void {
    const set = this.listeners.get(event.method);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event.params ?? {});
      } catch (err) {
        this.opts.onListenerError?.(event.method, err);
      }
    }
  }
}
