import type { CDPPayload } from '@slicc/shared-ts';

import { PendingRequestTable, waitForEvent } from '../cdp/pending-request-table.js';
import type { CDPStateListener, CDPTransport } from '../cdp/transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../cdp/types.js';

export interface ParsedCdpResponse {
  id: number;

  result?: CDPPayload;
  error?: string;
}

export interface ParsedCdpEvent {
  method: string;

  params?: CDPPayload;
}

export interface ParsedCdpControl {
  kind: 'reset' | 'ready';
  reason?: string;
}

export interface CdpBridgeOptions {
  buildCommandEnvelope: (
    id: number,
    method: string,
    params?: CDPPayload,
    sessionId?: string
  ) => unknown;

  sendEnvelope: (envelope: unknown) => Promise<void>;

  subscribeIncoming: (handler: (envelope: unknown) => void) => () => void;

  parseResponse: (envelope: unknown) => ParsedCdpResponse | null;

  parseEvent: (envelope: unknown) => ParsedCdpEvent | null;

  parseControl?: (envelope: unknown) => ParsedCdpControl | null;

  onUpstreamReady?: () => void;

  onUpstreamReset?: (reason: string) => void;

  onListenerError?: (event: string, err: unknown) => void;

  onUnknownResponseId?: (id: number) => void;

  onSubscribeEvent?: (event: string) => void;

  onUnsubscribeEvent?: (event: string) => void;

  label?: string;
}

export class CdpTransportBridge implements CDPTransport {
  private _state: ConnectionState = 'disconnected';
  private nextCommandId = 1;
  private listeners = new Map<string, Set<CDPEventListener>>();
  private pendingCommands = new PendingRequestTable<number>();
  private unsubscribe: (() => void) | null = null;
  private stateListeners = new Set<CDPStateListener>();
  private lastNotifiedState: ConnectionState = 'disconnected';
  private lastNotifiedReason: string | undefined;
  private readonly opts: CdpBridgeOptions;
  private readonly label: string;

  constructor(opts: CdpBridgeOptions) {
    this.opts = opts;
    this.label = opts.label ?? 'CDP transport';
  }

  get state(): ConnectionState {
    return this._state;
  }

  onStateChange(listener: CDPStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }

    if (!this.unsubscribe) {
      this.unsubscribe = this.opts.subscribeIncoming((envelope) => this.handleIncoming(envelope));
    }
    this._state = 'connected';
    this.notifyState('connected');
  }

  disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    const reason = `${this.label} disconnected`;
    this.pendingCommands.rejectAll(reason);
    this.listeners.clear();
    this._state = 'disconnected';
    this.notifyState('disconnected', reason);
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

  private handleControl(control: ParsedCdpControl): void {
    if (control.kind === 'ready') {
      this.opts.onUpstreamReady?.();
      return;
    }
    const reason = control.reason ?? 'upstream connection reset';
    const rejectReason = `${this.label}: upstream CDP connection was reset (${reason})`;
    this.pendingCommands.rejectAll(rejectReason);
    this._state = 'disconnected';
    this.opts.onUpstreamReset?.(reason);
    this.notifyState('disconnected', rejectReason);
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
