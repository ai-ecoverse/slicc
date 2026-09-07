/**
 * Low-level Chrome DevTools Protocol client.
 *
 * Connects to a CDP endpoint via WebSocket and provides:
 * - send(method, params) → Promise<result>
 * - on(event, listener) / off(event, listener)
 * - Session management for target-specific commands
 */

import type { CDPPayload } from '@slicc/shared-ts';

import { createLogger } from '../base/logger.js';
import { PendingRequestTable, waitForEvent } from './pending-request-table.js';
import type { CDPStateListener, CDPTransport } from './transport.js';
import type {
  CDPCommand,
  CDPConnectOptions,
  CDPEvent,
  CDPEventListener,
  CDPMessage,
  CDPResponse,
  ConnectionState,
} from './types.js';

const log = createLogger('cdp');

/**
 * WebSocket close code the standalone CDP proxy uses when it evicts this
 * client because a newer client (another SLICC tab/window on the same
 * instance) took the single proxy slot. Application-range (4000-4999) code;
 * MUST stay in sync with `CDP_SUPERSEDED_CLOSE_CODE` in
 * `packages/node-server/src/index.ts`.
 */
export const CDP_SUPERSEDED_CLOSE_CODE = 4001;

/**
 * WebSocket close code the CDP proxy uses when its own Chrome-leg WebSocket
 * dropped and was re-established (or definitively failed). Chrome discards
 * every CDP session when that socket closes, so the sessionIds this client
 * cached are dead. Unlike {@link CDP_SUPERSEDED_CLOSE_CODE} the slot is still
 * ours — we do NOT latch superseded, and the next command reconnects lazily
 * via `BrowserAPI.ensureConnected()`, which resets the session state.
 * Application-range (4000-4999) code; MUST stay in sync with
 * `CDP_UPSTREAM_RESET_CLOSE_CODE` in
 * `packages/node-server/src/cdp-proxy/close-codes.ts`.
 */
export const CDP_UPSTREAM_RESET_CLOSE_CODE = 4002;

/**
 * Reason pending commands are rejected with after a close. Distinct strings so
 * callers and logs can tell a supersede ("another SLICC tab took our slot")
 * from an upstream reset ("Chrome's socket was rebuilt under us") from Chrome
 * simply going away.
 */
function closeRejectReason(code?: number): string {
  if (code === CDP_SUPERSEDED_CLOSE_CODE) {
    return 'CDP connection superseded by another SLICC tab/window on this instance';
  }
  if (code === CDP_UPSTREAM_RESET_CLOSE_CODE) {
    return 'CDP connection reset by proxy (upstream Chrome connection was re-established)';
  }
  return 'CDP connection closed';
}

export class CDPClient implements CDPTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private _superseded = false;
  private pending = new PendingRequestTable<number>();
  private listeners = new Map<string, Set<CDPEventListener>>();
  private _state: ConnectionState = 'disconnected';
  private stateListeners = new Set<CDPStateListener>();
  private lastNotifiedState: ConnectionState = 'disconnected';
  private lastNotifiedReason: string | undefined;

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Observe connection-state transitions (see {@link CDPTransport.onStateChange}).
   *
   * The kernel-worker hop needs this: `startPageCdpForwarder` relays a drop as
   * a `cdp-reset` wire message so `WorkerCdpProxy` can flip its own state and
   * the worker's `BrowserAPI` stops reusing a session Chrome has discarded.
   */
  onStateChange(listener: CDPStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * True when the last close was the proxy evicting us in favour of a newer
   * client (close code {@link CDP_SUPERSEDED_CLOSE_CODE}). Higher layers
   * (`BrowserAPI.ensureConnected`) read this to STOP auto-reconnecting —
   * otherwise two webapp tabs on one standalone instance would evict each
   * other over the single CDP proxy slot forever. Cleared on the next
   * successful `connect()` (e.g. a tab reload) and on explicit `disconnect()`.
   */
  get superseded(): boolean {
    return this._superseded;
  }

  /**
   * Connect to a CDP WebSocket endpoint.
   */
  async connect(options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    if (!options?.url) {
      throw new Error('CDPClient.connect() requires a WebSocket URL');
    }

    const { url, timeout = 5000, protocols } = options;
    this._state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cleanup();
        reject(new Error(`CDP connection timed out after ${timeout}ms`));
      }, timeout);

      try {
        this.ws = protocols !== undefined ? new WebSocket(url, protocols) : new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        this._state = 'disconnected';
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        clearTimeout(timer);
        this._state = 'connected';
        this._superseded = false; // a fresh connection clears any prior eviction latch
        log.info('Connected', { url });
        this.notifyState('connected');
        resolve();
      };

      this.ws.onerror = (ev) => {
        clearTimeout(timer);
        if (this._state === 'connecting') {
          log.error('Connection failed', { url });
          this.cleanup();
          reject(new Error('CDP WebSocket connection failed'));
        }
      };

      this.ws.onmessage = (ev) => {
        this.handleMessage(ev.data as string);
      };

      this.ws.onclose = (ev) => {
        this.handleClose((ev as { code?: number } | undefined)?.code);
      };
    });
  }

  /**
   * Disconnect from the CDP endpoint.
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null; // prevent handleClose from firing
      this.ws.close();
    }
    this._superseded = false; // an explicit teardown is not a supersede
    this.cleanup();
    log.info('Disconnected');
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout = 30000
  ): Promise<CDPPayload> {
    if (this._state !== 'connected' || !this.ws) {
      throw new Error('CDP client is not connected');
    }

    const id = this.nextId++;
    const message: CDPCommand = { id, method };
    if (params) message.params = params;
    if (sessionId) message.sessionId = sessionId;

    log.debug('Send', { method, id, sessionId });

    const response = this.pending.issue(
      id,
      timeout,
      `CDP command timed out after ${timeout}ms: ${method}`
    );
    this.ws.send(JSON.stringify(message));
    return response;
  }

  /**
   * Subscribe to a CDP event.
   */
  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  /**
   * Unsubscribe from a CDP event.
   */
  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  /**
   * Wait for a specific CDP event to fire once.
   */
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
  // Private
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(raw) as CDPMessage;
    } catch {
      return; // Ignore unparseable messages
    }

    // Response to a command we sent
    if ('id' in msg && typeof msg.id === 'number') {
      const response = msg as CDPResponse;
      log.debug('Response', { id: response.id, hasError: !!response.error });
      if (response.error) {
        log.error('Command error', {
          id: response.id,
          code: response.error.code,
          message: response.error.message,
        });
        this.pending.reject(
          response.id,
          new Error(`CDP error: ${response.error.message} (${response.error.code})`)
        );
      } else {
        this.pending.resolve(response.id, response.result ?? {});
      }
      return;
    }

    // Event notification
    if ('method' in msg) {
      const event = msg as CDPEvent;
      log.debug('Event', { method: event.method, sessionId: event.sessionId });
      const set = this.listeners.get(event.method);
      if (set) {
        // Include sessionId in params so listeners can filter by session
        const paramsWithSession = event.sessionId
          ? { ...event.params, sessionId: event.sessionId }
          : (event.params ?? {});
        for (const listener of set) {
          try {
            listener(paramsWithSession);
          } catch {
            // Don't let one listener break others
          }
        }
      }
    }
  }

  private handleClose(code?: number): void {
    if (code === CDP_SUPERSEDED_CLOSE_CODE) {
      // The proxy gave our single CDP slot to a newer client — another SLICC
      // tab/window on this instance. Latch it so the reconnect supervisor
      // stops re-dialing (which would evict the newcomer and restart the war).
      this._superseded = true;
      log.warn('CDP slot superseded by another SLICC tab/window on this instance', { code });
    } else if (code === CDP_UPSTREAM_RESET_CLOSE_CODE) {
      // The proxy rebuilt its Chrome leg; every CDP session behind it is gone.
      // Deliberately NOT a supersede — the slot is still ours, so `cleanup()`
      // leaving state 'disconnected' is enough for `ensureConnected()` to
      // re-dial (and reset session state) on the next command.
      log.warn('CDP proxy reset its upstream Chrome connection — sessions dropped', {
        code,
        pendingCommands: this.pending.size,
      });
    } else {
      log.error('Connection closed unexpectedly', { pendingCommands: this.pending.size });
    }
    const reason = closeRejectReason(code);
    this.pending.rejectAll(reason);
    this.cleanup();
    // Re-announce the drop with the specific close reason; `cleanup()` has
    // already flipped the state with a generic one.
    this.notifyState('disconnected', reason);
  }

  private cleanup(): void {
    this.ws = null;
    this._state = 'disconnected';
    this.pending.rejectAll('CDP client disconnected');
    this.notifyState('disconnected', 'CDP client disconnected');
  }

  /**
   * Fan a state transition out to `onStateChange` subscribers.
   *
   * Repeats of the same (state, reason) pair are dropped so a subscriber sees
   * one notification per transition. A close still notifies twice — once from
   * `cleanup()` and once from `handleClose()` with the specific close reason —
   * because the reason differs; `startPageCdpForwarder` collapses the pair
   * into a single `cdp-reset` by tracking the state it last relayed.
   */
  private notifyState(state: ConnectionState, reason?: string): void {
    if (state === this.lastNotifiedState && reason === this.lastNotifiedReason) return;
    this.lastNotifiedState = state;
    this.lastNotifiedReason = reason;
    for (const listener of this.stateListeners) {
      try {
        listener(state, reason);
      } catch {
        // A state observer must not break the CDP path.
      }
    }
  }
}
