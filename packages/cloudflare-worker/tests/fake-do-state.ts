/**
 * Shared test infrastructure: fake DurableObject state that models WebSocket
 * hibernation APIs (tags, attachments, auto-response).
 */

import type { SessionTrayDurableObject } from '../src/session-tray.js';
import type { DurableObjectStateLike } from '../src/shared.js';

export class FakeStorage {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }
}

type ListenerMap = Map<string, Array<(event: { data?: string }) => void>>;

export interface FakeWebSocket {
  readonly sent: string[];
  readonly received: string[];
  peer: FakeWebSocket | null;
  accept(): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: string }) => void
  ): void;
  send(data: string): void;
  close(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export class FakeDurableObjectState implements DurableObjectStateLike {
  readonly storage = new FakeStorage();
  instance: SessionTrayDurableObject | null = null;
  private readonly sockets = new Map<FakeWebSocket, { tags: string[]; attachment: unknown }>();
  private readonly listeners = new WeakMap<FakeWebSocket, ListenerMap>();
  autoResponse: unknown;

  makeSocket(): FakeWebSocket {
    const self = this;
    const listeners: ListenerMap = new Map();
    const sent: string[] = [];
    const received: string[] = [];
    let peer: FakeWebSocket | null = null;

    const dispatch = (type: 'message' | 'close' | 'error', event: { data?: string }) => {
      if (type === 'message' && event.data) {
        received.push(event.data);
      }
      const typeListeners = listeners.get(type) ?? [];
      for (const listener of typeListeners) {
        listener(event);
      }
    };

    const ws: FakeWebSocket = {
      sent,
      received,
      get peer() {
        return peer;
      },
      set peer(value: FakeWebSocket | null) {
        peer = value;
      },

      accept() {},

      addEventListener(
        type: 'message' | 'close' | 'error',
        listener: (event: { data?: string }) => void
      ) {
        const existing = listeners.get(type) ?? [];
        listeners.set(type, [...existing, listener]);
      },

      send(data: string) {
        sent.push(data);
        peer?.['dispatch']?.('message', { data });
      },

      close() {
        const p = peer;
        peer = null;
        dispatch('close', {});
        if (p) {
          p.peer = null;
          p['dispatch']?.('close', {});
        }
      },

      serializeAttachment(value: unknown) {
        const entry = self.sockets.get(ws);
        if (entry) {
          entry.attachment = value;
        }
      },

      deserializeAttachment() {
        return self.sockets.get(ws)?.attachment;
      },
    };

    // Store dispatch method via property so peers can call it
    Object.defineProperty(ws, 'dispatch', {
      value: dispatch,
      writable: false,
      enumerable: false,
    });

    self.listeners.set(ws, listeners);
    return ws;
  }

  acceptWebSocket(ws: FakeWebSocket, tags: string[] = []): void {
    this.sockets.set(ws, { tags, attachment: undefined });
    ws.addEventListener('message', (event) => {
      void this.instance?.webSocketMessage(ws, event.data ?? '');
    });
    ws.addEventListener('close', () => {
      this.sockets.delete(ws);
      void this.instance?.webSocketClose(ws);
    });
    ws.addEventListener('error', () => {
      void this.instance?.webSocketError(ws);
    });
  }

  getWebSockets(tag?: string): FakeWebSocket[] {
    const all = [...this.sockets.keys()];
    return tag ? all.filter((w) => this.sockets.get(w)!.tags.includes(tag)) : all;
  }

  getTags(ws: FakeWebSocket): string[] {
    return this.sockets.get(ws)?.tags ?? [];
  }

  setWebSocketAutoResponse(pair: unknown): void {
    this.autoResponse = pair;
  }
}

export function createFakeWebSocketPair(): { client: FakeWebSocket; server: FakeWebSocket } {
  const state = new FakeDurableObjectState();
  const client = state.makeSocket();
  const server = state.makeSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}
