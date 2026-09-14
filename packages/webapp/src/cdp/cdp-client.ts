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

export const CDP_SUPERSEDED_CLOSE_CODE = 4001;

export const CDP_UPSTREAM_RESET_CLOSE_CODE = 4002;

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

  onStateChange(listener: CDPStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  get superseded(): boolean {
    return this._superseded;
  }

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
        this._superseded = false;
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

  disconnect(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this._superseded = false;
    this.cleanup();
    log.info('Disconnected');
  }

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

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
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

  private handleMessage(raw: string): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(raw) as CDPMessage;
    } catch {
      return;
    }

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

    if ('method' in msg) {
      const event = msg as CDPEvent;
      log.debug('Event', { method: event.method, sessionId: event.sessionId });
      const set = this.listeners.get(event.method);
      if (set) {
        const paramsWithSession = event.sessionId
          ? { ...event.params, sessionId: event.sessionId }
          : (event.params ?? {});
        for (const listener of set) {
          try {
            listener(paramsWithSession);
          } catch {}
        }
      }
    }
  }

  private handleClose(code?: number): void {
    if (code === CDP_SUPERSEDED_CLOSE_CODE) {
      this._superseded = true;
      log.warn('CDP slot superseded by another SLICC tab/window on this instance', { code });
    } else if (code === CDP_UPSTREAM_RESET_CLOSE_CODE) {
      log.warn('CDP proxy reset its upstream Chrome connection — sessions dropped', {
        code,
        pendingCommands: this.pending.size,
      });
    } else {
      log.error('Connection closed unexpectedly', { pendingCommands: this.pending.size });
    }

    this.cleanup(closeRejectReason(code));
  }

  private cleanup(reason = 'CDP client disconnected'): void {
    this.ws = null;
    this._state = 'disconnected';
    this.pending.rejectAll(reason);
    this.notifyState('disconnected', reason);
  }

  private notifyState(state: ConnectionState, reason?: string): void {
    if (state === this.lastNotifiedState && reason === this.lastNotifiedReason) return;
    this.lastNotifiedState = state;
    this.lastNotifiedReason = reason;
    for (const listener of this.stateListeners) {
      try {
        listener(state, reason);
      } catch {}
    }
  }
}
