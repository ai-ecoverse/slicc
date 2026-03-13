import { beforeEach, describe, expect, it, vi } from 'vitest';

type OnMessageListener = (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void | boolean;
type DebuggerEventListener = (source: { tabId: number }, method: string, params?: Record<string, unknown>) => void;
type DebuggerDetachListener = (source: { tabId: number }, reason: string) => void;

const runtimeMessageListeners: OnMessageListener[] = [];
const runtimeSentMessages: unknown[] = [];
const installedListeners: Array<() => void> = [];
const debuggerEventListeners: DebuggerEventListener[] = [];
const debuggerDetachListeners: DebuggerDetachListener[] = [];

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event?: { data?: unknown }) => void>>();
  closeArgs: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: { data?: unknown }) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = { code, reason };
  }

  emit(type: string, event?: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createChromeMock() {
  return {
    sidePanel: {
      setPanelBehavior: vi.fn(),
    },
    offscreen: {
      hasDocument: vi.fn(async () => true),
      createDocument: vi.fn(),
    },
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        runtimeSentMessages.push(message);
      }),
      onMessage: {
        addListener: vi.fn((listener: OnMessageListener) => {
          runtimeMessageListeners.push(listener);
        }),
      },
      onInstalled: {
        addListener: vi.fn((listener: () => void) => {
          installedListeners.push(listener);
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 123, url })),
    },
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
      onEvent: {
        addListener: vi.fn((listener: DebuggerEventListener) => {
          debuggerEventListeners.push(listener);
        }),
      },
      onDetach: {
        addListener: vi.fn((listener: DebuggerDetachListener) => {
          debuggerDetachListeners.push(listener);
        }),
      },
    },
  };
}

function dispatchOffscreenMessage(payload: unknown): void {
  for (const listener of runtimeMessageListeners) {
    listener({ source: 'offscreen', payload }, {}, () => {});
  }
}

describe('extension service worker tray socket proxy', () => {
  beforeEach(async () => {
    runtimeMessageListeners.length = 0;
    runtimeSentMessages.length = 0;
    installedListeners.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    MockWebSocket.instances.length = 0;
    vi.clearAllMocks();
    vi.resetModules();

    (globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }).chrome = createChromeMock();
    (globalThis as typeof globalThis & { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket as never;

    await import('./service-worker.js');
  });

  it('hosts the leader tray socket in the service worker and relays frames', async () => {
    dispatchOffscreenMessage({ type: 'tray-socket-open', id: 7, url: 'wss://tray.example.com/controller' });

    expect(MockWebSocket.instances).toHaveLength(1);
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('wss://tray.example.com/controller');

    socket.emit('open');
    socket.emit('message', { data: '{"type":"leader.connected"}' });
    await Promise.resolve();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: { type: 'tray-socket-opened', id: 7 },
    });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: { type: 'tray-socket-message', id: 7, data: '{"type":"leader.connected"}' },
    });

    dispatchOffscreenMessage({ type: 'tray-socket-send', id: 7, data: '{"type":"ping"}' });
    expect(socket.sent).toEqual(['{"type":"ping"}']);

    dispatchOffscreenMessage({ type: 'tray-socket-close', id: 7, code: 1000, reason: 'done' });
    expect(socket.closeArgs).toEqual({ code: 1000, reason: 'done' });
  });

  it('reports tray socket command failures back to offscreen', async () => {
    dispatchOffscreenMessage({ type: 'tray-socket-send', id: 99, data: '{"type":"ping"}' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'tray-socket-error',
        id: 99,
        error: 'Tray socket 99 is not open',
      },
    });
  });
});