/**
 * `CdpTransportBridge` — shared base for proxied `CDPTransport`
 * implementations that need pending-command id allocation, listener
 * dispatch, timeout handling, and disconnect tear-down.
 *
 * Per-implementation differences are factored into `CdpBridgeOptions`:
 *  1. The outbound envelope shape (which `source` tag, which payload `type`).
 *  2. The inbound source filter (which envelope `source` to accept).
 *  3. The wire itself (chrome.runtime in the thin extension's
 *     `ExtensionBridgeTransport`; MessagePort in the kernel-worker's
 *     `WorkerCdpProxy`).
 *  4. Whether listener errors are logged or swallowed.
 *
 * Worker safety: this file uses only timers, `Map`, `Set`, and `Promise`.
 * No DOM, no chrome.* — typechecked under `tsconfig.webapp-worker.json`
 * via `transport.ts` (which is the only ambient type it depends on, and
 * itself a leaf module).
 */

import type { CDPPayload } from '@slicc/shared-ts';

import { PendingRequestTable, waitForEvent } from '../cdp/pending-request-table.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../cdp/types.js';

/** Decoded form of a CDP response, regardless of envelope shape. */
export interface ParsedCdpResponse {
  id: number;
  /** Per-method CDP result; shape is known only to the caller that issued the method. */
  result?: CDPPayload;
  error?: string;
}

/** Decoded form of a CDP event, regardless of envelope shape. */
export interface ParsedCdpEvent {
  method: string;
  /** Per-method CDP event params; shape depends on `method`. */
  params?: CDPPayload;
}

/**
 * Decoded form of an out-of-band control signal from the far side of the
 * wire: `'reset'` when it lost its upstream CDP connection (every session
 * minted on it is gone), `'ready'` when that connection came back.
 */
export interface ParsedCdpControl {
  kind: 'reset' | 'ready';
  reason?: string;
}

export interface CdpBridgeOptions {
  /**
   * Wrap `(id, method, params, sessionId)` into the outbound envelope
   * the wire expects. Result is whatever `sendEnvelope` accepts.
   */
  buildCommandEnvelope: (
    id: number,
    method: string,
    params?: CDPPayload,
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
   * Pluck an out-of-band control signal out of an inbound envelope. Returns
   * `null` if the envelope isn't one (it's a response or an event).
   *
   * Optional: only proxies whose far side owns a droppable upstream
   * connection need it. `WorkerCdpProxy` does — the page-side `CDPClient`'s
   * WebSocket can close underneath it — while the chrome.runtime proxies talk
   * to a service worker that has no separate upstream to lose.
   */
  parseControl?: (envelope: unknown) => ParsedCdpControl | null;

  /**
   * Fired when the far side reports its upstream connection came back
   * (`kind: 'ready'`). The bridge deliberately does NOT flip `state` back to
   * `'connected'` here — see {@link CdpTransportBridge.handleControl}.
   */
  onUpstreamReady?: () => void;

  /**
   * Fired when the far side reports its upstream connection was reset.
   * Diagnostic only; the bridge has already rejected the pending commands
   * and flipped `state` by the time this runs.
   */
  onUpstreamReset?: (reason: string) => void;

  /**
   * Logger for listener exceptions. Implementations historically split
   * between silent-drop and warn-and-continue; configurable here.
   */
  onListenerError?: (event: string, err: unknown) => void;

  /**
   * Logger for unrecognized response ids. Optional; `console.warn` and
   * silent-drop are both valid policies.
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

export class CdpTransportBridge implements CDPTransport {
  private _state: ConnectionState = 'disconnected';
  private nextCommandId = 1;
  private listeners = new Map<string, Set<CDPEventListener>>();
  private pendingCommands = new PendingRequestTable<number>();
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
    // An upstream reset leaves the wire subscription in place and flips only
    // `state`, so a re-connect after one must not stack a second incoming
    // handler (which would double-dispatch every event and make every
    // response look like an unknown id on the second pass).
    if (!this.unsubscribe) {
      this.unsubscribe = this.opts.subscribeIncoming((envelope) => this.handleIncoming(envelope));
    }
    this._state = 'connected';
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    this.pendingCommands.rejectAll(`${this.label} disconnected`);
    this.listeners.clear();
    this._state = 'disconnected';
  }

  async send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout = 30000
  ): Promise<CDPPayload> {
    if (this._state !== 'connected') {
      throw new Error(`${this.label} is not connected`);
    }

    const id = this.nextCommandId++;
    const envelope = this.opts.buildCommandEnvelope(id, method, params, sessionId);

    const response = this.pendingCommands.issue(
      id,
      timeout,
      `CDP command timed out after ${timeout}ms: ${method}`
    );

    this.opts.sendEnvelope(envelope).catch((err: unknown) => {
      this.pendingCommands.reject(
        id,
        new Error(`Failed to send CDP command: ${err instanceof Error ? err.message : String(err)}`)
      );
    });

    return response;
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

  once(event: string, timeout = 30000): Promise<CDPPayload> {
    return waitForEvent<CDPPayload>(
      (handler) => {
        this.on(event, handler);
        return () => this.off(event, handler);
      },
      timeout,
      `Timed out waiting for event: ${event}`
    );
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private handleIncoming(envelope: unknown): void {
    const control = this.opts.parseControl?.(envelope) ?? null;
    if (control) {
      this.handleControl(control);
      return;
    }
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

  /**
   * Handle an upstream reset / ready signal from the far side.
   *
   * On `reset` the far side's CDP connection is gone, taking every session
   * minted on it with it. Pending commands can never be answered, so reject
   * them with a reason that names the cause, and flip `state` to
   * `'disconnected'` — that is the ONLY signal `BrowserAPI.ensureConnected()`
   * reads, and without it the worker keeps sending commands against a session
   * Chrome has already discarded (issue #2417 / DIAGNOSIS § 2.7).
   *
   * `ready` deliberately does NOT flip back: the state has to stay
   * `'disconnected'` until `BrowserAPI.ensureConnected()` observes it, clears
   * its session cache and calls `connect()` — which flips it. Auto-flipping
   * here would race the worker back into the stale-session bug we just fixed.
   *
   * The wire subscription and the listener registry both survive a reset: the
   * MessagePort is still alive, and the page forwarder re-registers our event
   * subscriptions on its own transport when the upstream comes back (the
   * bridge's 0→1 `onSubscribeEvent` edge never fires again for listeners the
   * worker still holds).
   */
  private handleControl(control: ParsedCdpControl): void {
    if (control.kind === 'ready') {
      this.opts.onUpstreamReady?.();
      return;
    }
    const reason = control.reason ?? 'upstream connection reset';
    this.pendingCommands.rejectAll(`${this.label}: upstream CDP connection was reset (${reason})`);
    this._state = 'disconnected';
    this.opts.onUpstreamReset?.(reason);
  }

  private handleResponse(resp: ParsedCdpResponse): void {
    if (!this.pendingCommands.has(resp.id)) {
      this.opts.onUnknownResponseId?.(resp.id);
      return;
    }
    if (resp.error) {
      this.pendingCommands.reject(resp.id, new Error(resp.error));
    } else {
      this.pendingCommands.resolve(resp.id, resp.result ?? {});
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
