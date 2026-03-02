/**
 * Low-level Chrome DevTools Protocol client.
 *
 * Connects to a CDP endpoint via WebSocket and provides:
 * - send(method, params) → Promise<result>
 * - on(event, listener) / off(event, listener)
 * - Session management for target-specific commands
 */

import type {
  CDPCommand,
  CDPResponse,
  CDPEvent,
  CDPMessage,
  CDPConnectOptions,
  CDPEventListener,
  ConnectionState,
} from './types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cdp');

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private listeners = new Map<string, Set<CDPEventListener>>();
  private _state: ConnectionState = 'disconnected';

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Connect to a CDP WebSocket endpoint.
   */
  async connect(options: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }

    const { url, timeout = 5000 } = options;
    this._state = 'connecting';

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cleanup();
        reject(new Error(`CDP connection timed out after ${timeout}ms`));
      }, timeout);

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        this._state = 'disconnected';
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        clearTimeout(timer);
        this._state = 'connected';
        log.info('Connected', { url });
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

      this.ws.onclose = () => {
        this.handleClose();
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
    this.cleanup();
    log.info('Disconnected');
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout = 30000,
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected' || !this.ws) {
      throw new Error('CDP client is not connected');
    }

    const id = this.nextId++;
    const message: CDPCommand = { id, method };
    if (params) message.params = params;
    if (sessionId) message.sessionId = sessionId;

    log.debug('Send', { method, id, sessionId });

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws!.send(JSON.stringify(message));
    });
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
      const p = this.pending.get(response.id);
      if (p) {
        this.pending.delete(response.id);
        if (response.error) {
          log.error('Command error', { id: response.id, code: response.error.code, message: response.error.message });
          p.reject(new Error(`CDP error: ${response.error.message} (${response.error.code})`));
        } else {
          p.resolve(response.result ?? {});
        }
      }
      return;
    }

    // Event notification
    if ('method' in msg) {
      const event = msg as CDPEvent;
      log.debug('Event', { method: event.method, sessionId: event.params?.sessionId });
      const set = this.listeners.get(event.method);
      if (set) {
        for (const listener of set) {
          try {
            listener(event.params ?? {});
          } catch {
            // Don't let one listener break others
          }
        }
      }
    }
  }

  private handleClose(): void {
    log.error('Connection closed unexpectedly', { pendingCommands: this.pending.size });
    // Reject all pending commands
    for (const [, p] of this.pending) {
      p.reject(new Error('CDP connection closed'));
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.ws = null;
    this._state = 'disconnected';
    this.pending.clear();
  }
}
