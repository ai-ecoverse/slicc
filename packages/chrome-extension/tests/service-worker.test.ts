import { beforeEach, describe, expect, it, vi } from 'vitest';

type OnMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void
) => void | boolean;
type DebuggerEventListener = (
  source: { tabId: number },
  method: string,
  params?: Record<string, unknown>
) => void;
type DebuggerDetachListener = (source: { tabId: number }, reason: string) => void;

const runtimeMessageListeners: OnMessageListener[] = [];
const runtimeExternalMessageListeners: OnMessageListener[] = [];
const runtimeSentMessages: unknown[] = [];
const installedListeners: Array<() => void> = [];
const debuggerEventListeners: DebuggerEventListener[] = [];
const debuggerDetachListeners: DebuggerDetachListener[] = [];
let storageState: Record<string, unknown> = {};

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
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(),
    },
    offscreen: {
      hasDocument: vi.fn(async () => true),
      createDocument: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (keys == null) return { ...storageState };
          if (typeof keys === 'string') {
            return { [keys]: storageState[keys] };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageState[key]]));
          }
          return Object.fromEntries(
            Object.entries(keys).map(([key, fallback]) => [key, storageState[key] ?? fallback])
          );
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          storageState = { ...storageState, ...items };
        }),
      },
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
      onMessageExternal: {
        addListener: vi.fn((listener: OnMessageListener) => {
          runtimeExternalMessageListeners.push(listener);
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
      group: vi.fn(async () => 99),
    },
    tabGroups: {
      update: vi.fn(async () => undefined),
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

function dispatchPanelMessage(payload: unknown): void {
  for (const listener of runtimeMessageListeners) {
    listener({ source: 'panel', payload }, {}, () => {});
  }
}

async function dispatchExternalMessage(
  message: unknown,
  sender: { url?: string } = { url: 'https://www.sliccy.ai/handoffs/abc123' }
): Promise<unknown> {
  const listener = runtimeExternalMessageListeners[0];
  return await new Promise((resolve) => {
    listener(message, sender, resolve);
  });
}

describe('extension service worker', () => {
  beforeEach(async () => {
    runtimeMessageListeners.length = 0;
    runtimeExternalMessageListeners.length = 0;
    runtimeSentMessages.length = 0;
    installedListeners.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    MockWebSocket.instances.length = 0;
    storageState = {};
    vi.clearAllMocks();
    vi.resetModules();

    (globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }).chrome =
      createChromeMock();
    (globalThis as typeof globalThis & { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as never;
    (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;

    await import('../src/service-worker.js');
  });

  it('hosts the leader tray socket in the service worker and relays frames', async () => {
    dispatchOffscreenMessage({
      type: 'tray-socket-open',
      id: 7,
      url: 'wss://tray.example.com/controller',
    });

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

  it('queues external handoffs and treats repeated delivery as idempotent', async () => {
    const payload = {
      type: 'handoff_message.v1',
      handoffId: '0123456789abcdef0123456789abcdef',
      payload: {
        title: 'Run a quick check',
        instruction: 'Continue this task in SLICC.',
        urls: ['https://example.com'],
        acceptanceCriteria: ['Confirm the page opens'],
      },
    };

    const first = await dispatchExternalMessage(payload);
    expect(first).toEqual({ status: 'queued' });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: [
          expect.objectContaining({
            handoffId: '0123456789abcdef0123456789abcdef',
          }),
        ],
      },
    });
    expect((chrome.action.setBadgeText as any).mock.calls.at(-1)?.[0]).toEqual({ text: '1' });

    const second = await dispatchExternalMessage(payload);
    expect(second).toEqual({ status: 'duplicate' });
    const pendingStore = storageState['slicc.pendingHandoffs'] as Record<string, unknown>;
    expect(Object.keys(pendingStore)).toHaveLength(1);
  });

  it('accepts localhost and workers.dev relay pages in dev builds', async () => {
    const localhostResponse = await dispatchExternalMessage(
      {
        type: 'handoff_message.v1',
        handoffId: '11111111111111111111111111111111',
        payload: {
          instruction: 'Continue this task in SLICC from localhost.',
        },
      },
      { url: 'http://localhost:8787/handoffs/test' }
    );

    expect(localhostResponse).toEqual({ status: 'queued' });

    const workersDevResponse = await dispatchExternalMessage(
      {
        type: 'handoff_message.v1',
        handoffId: '22222222222222222222222222222222',
        payload: {
          instruction: 'Continue this task in SLICC from preview.',
        },
      },
      { url: 'https://sliccy-preview.workers.dev/handoffs/test' }
    );

    expect(workersDevResponse).toEqual({ status: 'queued' });
  });

  it('rejects unsupported external origins', async () => {
    const response = await dispatchExternalMessage(
      {
        type: 'handoff_message.v1',
        handoffId: '33333333333333333333333333333333',
        payload: {
          instruction: 'This origin should be rejected.',
        },
      },
      { url: 'https://example.com/handoffs/test' }
    );

    expect(response).toEqual({
      status: 'rejected',
      error:
        'External handoffs are only allowed from https://www.sliccy.ai, localhost/127.0.0.1 over http(s), and https://*.workers.dev.',
    });
  });

  it('accepts a pending handoff, opens requested URLs, and injects it into the cone', async () => {
    await dispatchExternalMessage({
      type: 'handoff_message.v1',
      handoffId: 'fedcba9876543210fedcba9876543210',
      payload: {
        instruction: 'Please continue this task.',
        urls: ['https://example.com/path'],
        openUrlsFirst: true,
      },
    });

    runtimeSentMessages.length = 0;

    dispatchPanelMessage({
      type: 'handoff-accept',
      handoffId: 'fedcba9876543210fedcba9876543210',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/path',
      active: false,
    });
    expect(runtimeSentMessages).toContainEqual({
      source: 'panel',
      payload: {
        type: 'handoff-inject',
        handoff: expect.objectContaining({
          handoffId: 'fedcba9876543210fedcba9876543210',
        }),
      },
    });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: [],
      },
    });
    expect((chrome.action.setBadgeText as any).mock.calls.at(-1)?.[0]).toEqual({ text: '' });
  });

  it('dismisses a pending handoff without injecting it', async () => {
    await dispatchExternalMessage({
      type: 'handoff_message.v1',
      handoffId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      payload: {
        instruction: 'Dismiss me.',
      },
    });

    runtimeSentMessages.length = 0;

    dispatchPanelMessage({
      type: 'handoff-dismiss',
      handoffId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: [],
      },
    });
    expect(runtimeSentMessages).not.toContainEqual(
      expect.objectContaining({
        source: 'panel',
        payload: expect.objectContaining({ type: 'handoff-inject' }),
      })
    );
  });
});
