/**
 * OffscreenCdpProxy — CDPTransport implementation for the offscreen document.
 *
 * Routes CDP commands through chrome.runtime messages to the service worker,
 * which has chrome.debugger access. Receives CDP events back from the service
 * worker via the same messaging channel.
 */

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';
import type { CDPTransport } from './transport.js';
import type {
  CdpCommandMsg,
  CdpResponseMsg,
  CdpEventMsg,
  ExtensionMessage,
} from '../extension/messages.js';

export class OffscreenCdpProxy implements CDPTransport {
  private _state: ConnectionState = 'disconnected';
  private nextCommandId = 1;
  private listeners = new Map<string, Set<CDPEventListener>>();
  private pendingCommands = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private messageHandler: ((message: unknown) => void) | null = null;

  get state(): ConnectionState {
    return this._state;
  }

  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }

    // Listen for CDP responses and events from the service worker
    this.messageHandler = (message: unknown) => {
      if (!isExtMsg(message)) return;
      const msg = message as ExtensionMessage;
      if (msg.source !== 'service-worker') return;

      const payload = msg.payload;
      if (payload.type === 'cdp-response') {
        this.handleCdpResponse(payload as CdpResponseMsg);
      } else if (payload.type === 'cdp-event') {
        this.handleCdpEvent(payload as CdpEventMsg);
      }
    };

    chrome.runtime.onMessage.addListener(this.messageHandler as any);
    this._state = 'connected';
  }

  disconnect(): void {
    if (this.messageHandler) {
      chrome.runtime.onMessage.removeListener(this.messageHandler as any);
      this.messageHandler = null;
    }

    // Reject all pending commands
    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP proxy disconnected'));
    }
    this.pendingCommands.clear();
    this.listeners.clear();
    this._state = 'disconnected';
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeout = 30000,
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') {
      throw new Error('OffscreenCdpProxy is not connected');
    }

    const id = this.nextCommandId++;
    const cmd: CdpCommandMsg = {
      type: 'cdp-command',
      id,
      method,
      params,
      sessionId,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(id);
        reject(new Error(`CDP command timed out after ${timeout}ms: ${method}`));
      }, timeout);

      this.pendingCommands.set(id, { resolve, reject, timer });

      // Send via chrome.runtime.sendMessage — service worker intercepts CDP commands
      chrome.runtime.sendMessage({
        source: 'offscreen' as const,
        payload: cmd,
      }).catch((err) => {
        if (settled) return;
        settled = true;
        this.pendingCommands.delete(id);
        clearTimeout(timer);
        reject(new Error(`Failed to send CDP command: ${err instanceof Error ? err.message : String(err)}`));
      });
    });
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

  private handleCdpResponse(resp: CdpResponseMsg): void {
    const pending = this.pendingCommands.get(resp.id);
    if (!pending) return;

    this.pendingCommands.delete(resp.id);
    clearTimeout(pending.timer);

    if (resp.error) {
      pending.reject(new Error(resp.error));
    } else {
      pending.resolve(resp.result ?? {});
    }
  }

  private handleCdpEvent(event: CdpEventMsg): void {
    const set = this.listeners.get(event.method);
    if (set) {
      for (const listener of set) {
        try {
          listener(event.params ?? {});
        } catch {
          // Listener errors should not break the event loop
        }
      }
    }
  }
}

function isExtMsg(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'source' in msg &&
    'payload' in msg
  );
}
