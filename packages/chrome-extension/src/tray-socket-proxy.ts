import type { LeaderTrayWebSocket } from '../scoops/tray-leader.js';
import {
  isExtensionMessage,
  type ExtensionMessage,
  type TraySocketCommandMessage,
  type TraySocketEventMessage,
} from './messages.js';

type TraySocketEventType = 'open' | 'message' | 'close' | 'error';
type TraySocketListener = (event: { data?: unknown }) => void;

export class ServiceWorkerLeaderTraySocket implements LeaderTrayWebSocket {
  private static nextId = 1;

  private readonly id = ServiceWorkerLeaderTraySocket.nextId++;
  private readonly listeners = new Map<TraySocketEventType, Set<TraySocketListener>>();
  private readonly messageHandler = (message: unknown) => {
    if (!isExtensionMessage(message)) return;
    const envelope = message as ExtensionMessage;
    if (envelope.source !== 'service-worker') return;
    this.handleServiceWorkerEvent(envelope.payload as TraySocketEventMessage);
  };
  private closeRequested = false;
  private cleanedUp = false;

  constructor(private readonly url: string) {
    chrome.runtime.onMessage.addListener(this.messageHandler as never);
    queueMicrotask(() => {
      if (this.closeRequested) return;
      void this.post({ type: 'tray-socket-open', id: this.id, url: this.url }).catch((error) => {
        this.dispatch('error', { data: error instanceof Error ? error.message : String(error) });
        this.cleanup();
      });
    });
  }

  addEventListener(type: TraySocketEventType, listener: TraySocketListener): void {
    let callbacks = this.listeners.get(type);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(type, callbacks);
    }
    callbacks.add(listener);
  }

  send(data: string): void {
    if (this.closeRequested) {
      throw new Error('Tray leader WebSocket proxy is closed');
    }
    void this.post({ type: 'tray-socket-send', id: this.id, data }).catch((error) => {
      this.dispatch('error', { data: error instanceof Error ? error.message : String(error) });
      this.cleanup();
    });
  }

  close(code?: number, reason?: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    void this.post({ type: 'tray-socket-close', id: this.id, code, reason }).catch(() => {
      this.dispatch('close', {});
      this.cleanup();
    });
  }

  private handleServiceWorkerEvent(event: TraySocketEventMessage): void {
    if (event.id !== this.id) return;

    switch (event.type) {
      case 'tray-socket-opened':
        this.dispatch('open', {});
        break;
      case 'tray-socket-message':
        this.dispatch('message', { data: event.data });
        break;
      case 'tray-socket-error':
        this.dispatch('error', { data: event.error });
        this.cleanup();
        break;
      case 'tray-socket-closed':
        this.dispatch('close', {});
        this.cleanup();
        break;
    }
  }

  private dispatch(type: TraySocketEventType, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    chrome.runtime.onMessage.removeListener(this.messageHandler as never);
  }

  private async post(payload: TraySocketCommandMessage): Promise<void> {
    await chrome.runtime.sendMessage({
      source: 'offscreen' as const,
      payload,
    });
  }
}
