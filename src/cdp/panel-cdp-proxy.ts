/**
 * PanelCdpProxy — CDPTransport implementation for the extension side panel.
 *
 * Routes CDP commands through the offscreen document (which has CDP access
 * via OffscreenCdpProxy → service worker → chrome.debugger).
 *
 * Command path:  Panel → Offscreen → Service Worker → chrome.debugger
 * Response path: Offscreen → Panel (panel-cdp-response)
 * Event path:    Service Worker → Panel (cdp-event broadcast)
 */

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';
import type { CDPTransport } from './transport.js';
import type {
  PanelCdpCommandMsg,
  PanelCdpResponseMsg,
  CdpEventMsg,
  ExtensionMessage,
} from '../extension/messages.js';

export class PanelCdpProxy implements CDPTransport {
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

    this.messageHandler = (message: unknown) => {
      try {
        if (!isExtMsg(message)) return;
        const msg = message as ExtensionMessage;

        // Handle CDP command responses from offscreen
        if (msg.source === 'offscreen' && msg.payload.type === 'panel-cdp-response') {
          this.handleCdpResponse(msg.payload as PanelCdpResponseMsg);
        }

        // Handle CDP events broadcast from service worker
        if (msg.source === 'service-worker' && msg.payload.type === 'cdp-event') {
          this.handleCdpEvent(msg.payload as CdpEventMsg);
        }
      } catch (err) {
        console.error('[panel-cdp-proxy] Error in message handler:', err);
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

    for (const [, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Panel CDP proxy disconnected'));
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
      throw new Error('PanelCdpProxy is not connected');
    }

    const id = this.nextCommandId++;
    const cmd: PanelCdpCommandMsg = {
      type: 'panel-cdp-command',
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

      // Send via chrome.runtime.sendMessage — offscreen bridge intercepts panel-cdp-command
      chrome.runtime.sendMessage({
        source: 'panel' as const,
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

  private handleCdpResponse(resp: PanelCdpResponseMsg): void {
    const pending = this.pendingCommands.get(resp.id);
    if (!pending) {
      console.warn(`[panel-cdp-proxy] Ignoring CDP response with unknown id ${resp.id}`);
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

  private handleCdpEvent(event: CdpEventMsg): void {
    const set = this.listeners.get(event.method);
    if (set) {
      for (const listener of set) {
        try {
          listener(event.params ?? {});
        } catch (err) {
          console.error(`[panel-cdp-proxy] Listener error for event "${event.method}":`, err);
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
