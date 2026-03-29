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
type TabCreatedListener = (tab: { id?: number; url?: string }) => void;
type TabUpdatedListener = (
  tabId: number,
  changeInfo: { url?: string },
  tab: { id?: number; url?: string }
) => void;

const runtimeMessageListeners: OnMessageListener[] = [];
const runtimeSentMessages: unknown[] = [];
const installedListeners: Array<() => void> = [];
const debuggerEventListeners: DebuggerEventListener[] = [];
const debuggerDetachListeners: DebuggerDetachListener[] = [];
const tabCreatedListeners: TabCreatedListener[] = [];
const tabUpdatedListeners: TabUpdatedListener[] = [];
const storageState = new Map<string, unknown>();

async function readLocalStorage(
  keys?: string | string[] | Record<string, unknown> | null
): Promise<Record<string, unknown>> {
  if (typeof keys === 'string') {
    return { [keys]: storageState.get(keys) };
  }
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, storageState.get(key)]));
  }
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(
      Object.entries(keys).map(([key, defaultValue]) => [
        key,
        storageState.get(key) ?? defaultValue,
      ])
    );
  }
  return Object.fromEntries(storageState.entries());
}

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
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(readLocalStorage),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            storageState.set(key, value);
          }
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
      onInstalled: {
        addListener: vi.fn((listener: () => void) => {
          installedListeners.push(listener);
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async ({ url }: { url: string }) => ({ id: 123, url })),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      onCreated: {
        addListener: vi.fn((listener: TabCreatedListener) => {
          tabCreatedListeners.push(listener);
        }),
      },
      onUpdated: {
        addListener: vi.fn((listener: TabUpdatedListener) => {
          tabUpdatedListeners.push(listener);
        }),
      },
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
    identity: {
      launchWebAuthFlow: vi.fn(),
      getRedirectURL: vi.fn(),
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

function dispatchCreatedTab(tab: { id?: number; url?: string }): void {
  for (const listener of tabCreatedListeners) {
    listener(tab);
  }
}

function dispatchUpdatedTab(tabId: number, url: string): void {
  for (const listener of tabUpdatedListeners) {
    listener(tabId, { url }, { id: tabId, url });
  }
}

function buildHandoffUrl(
  payload: Record<string, unknown>,
  origin = 'https://www.sliccy.ai'
): string {
  return `${origin}/handoff#${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadServiceWorker(dev = false): Promise<void> {
  (globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = dev;
  await import('../src/service-worker.js');
}

describe('extension service worker', () => {
  beforeEach(async () => {
    runtimeMessageListeners.length = 0;
    runtimeSentMessages.length = 0;
    installedListeners.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    tabCreatedListeners.length = 0;
    tabUpdatedListeners.length = 0;
    storageState.clear();
    MockWebSocket.instances.length = 0;
    vi.clearAllMocks();
    vi.resetModules();

    (globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }).chrome =
      createChromeMock();
    (globalThis as typeof globalThis & { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as never;

    await loadServiceWorker(false);
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
    await flushAsync();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'tray-socket-error',
        id: 99,
        error: 'Tray socket 99 is not open',
      },
    });
  });

  it('captures matching handoff tabs, persists them, and updates the badge', async () => {
    const url = buildHandoffUrl({
      title: 'Verify signup',
      instruction: 'Check whether signup works.',
      urls: ['https://example.com/signup'],
      acceptanceCriteria: ['Form loads', 'Submit succeeds'],
    });

    dispatchUpdatedTab(42, url);
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
    expect(stored[0].sourceTabId).toBe(42);
    expect(stored[0].payload).toMatchObject({
      title: 'Verify signup',
      instruction: 'Check whether signup works.',
    });
    expect((globalThis as any).chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: expect.arrayContaining([
          expect.objectContaining({
            handoffId: expect.stringMatching(/^handoff-/),
            payload: expect.objectContaining({ instruction: 'Check whether signup works.' }),
          }),
        ]),
      },
    });
  });

  it('ignores non-matching handoff tabs', async () => {
    dispatchUpdatedTab(7, 'https://www.sliccy.ai/handoff#abc');
    dispatchCreatedTab({ id: 8, url: 'https://www.sliccy.ai/other#abc' });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toBeUndefined();
    expect(runtimeSentMessages).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'handoff-pending-list' }),
      })
    );
  });

  it('rejects localhost handoff tabs', async () => {
    const localhostUrl = buildHandoffUrl(
      { instruction: 'Ignore localhost handoff detection.' },
      'http://localhost:8787'
    );

    dispatchUpdatedTab(33, localhostUrl);
    await flushAsync();
    expect(storageState.get('slicc.pendingHandoffs')).toBeUndefined();
  });

  it('dedupes repeated tab events for the same handoff payload', async () => {
    const url = buildHandoffUrl({ instruction: 'Run the same handoff twice.' });

    dispatchCreatedTab({ id: 12, url });
    dispatchUpdatedTab(12, url);
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
  });

  it('serializes concurrent handoff arrivals so different tabs are not lost', async () => {
    const chromeMock = (globalThis as any).chrome;
    chromeMock.storage.local.get.mockImplementation(
      async (keys?: string | string[] | Record<string, unknown> | null) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return readLocalStorage(keys);
      }
    );

    dispatchUpdatedTab(12, buildHandoffUrl({ instruction: 'First concurrent handoff.' }));
    dispatchUpdatedTab(13, buildHandoffUrl({ instruction: 'Second concurrent handoff.' }));
    await flushAsync();
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.payload.instruction)).toEqual([
      'First concurrent handoff.',
      'Second concurrent handoff.',
    ]);
  });

  it('scans already-open handoff tabs when the service worker starts', async () => {
    runtimeMessageListeners.length = 0;
    runtimeSentMessages.length = 0;
    installedListeners.length = 0;
    debuggerEventListeners.length = 0;
    debuggerDetachListeners.length = 0;
    tabCreatedListeners.length = 0;
    tabUpdatedListeners.length = 0;
    storageState.clear();
    MockWebSocket.instances.length = 0;
    vi.resetModules();

    const chromeMock = createChromeMock();
    chromeMock.tabs.query.mockResolvedValue([
      {
        id: 77,
        url: buildHandoffUrl({ instruction: 'Pick me up from an already open tab.' }),
      },
    ]);

    (globalThis as typeof globalThis & { chrome: ReturnType<typeof createChromeMock> }).chrome =
      chromeMock;
    (globalThis as typeof globalThis & { WebSocket: typeof MockWebSocket }).WebSocket =
      MockWebSocket as never;

    await loadServiceWorker(false);
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    expect(stored).toHaveLength(1);
    expect(stored[0].sourceTabId).toBe(77);
  });

  it('publishes the current pending handoff list when requested by the panel', async () => {
    const url = buildHandoffUrl({ instruction: 'Send me the current queue.' });
    dispatchUpdatedTab(5, url);
    await flushAsync();
    runtimeSentMessages.length = 0;

    dispatchPanelMessage({ type: 'handoff-list-request' });
    await flushAsync();

    expect(runtimeSentMessages).toContainEqual({
      source: 'service-worker',
      payload: {
        type: 'handoff-pending-list',
        handoffs: expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ instruction: 'Send me the current queue.' }),
          }),
        ]),
      },
    });
  });

  it('clears a pending handoff and closes the source tab when dismissed or accepted', async () => {
    const url = buildHandoffUrl({ instruction: 'Clear this handoff.' });
    dispatchUpdatedTab(21, url);
    await flushAsync();

    const stored = storageState.get('slicc.pendingHandoffs') as Array<any>;
    const handoffId = stored[0].handoffId as string;

    dispatchPanelMessage({ type: 'handoff-dismiss', handoffId });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toEqual([]);
    expect((globalThis as any).chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect((globalThis as any).chrome.tabs.remove).toHaveBeenCalledWith(21);

    dispatchUpdatedTab(21, url);
    await flushAsync();
    const storedAgain = storageState.get('slicc.pendingHandoffs') as Array<any>;
    dispatchPanelMessage({ type: 'handoff-accept', handoffId: storedAgain[0].handoffId });
    await flushAsync();

    expect(storageState.get('slicc.pendingHandoffs')).toEqual([]);
    expect((globalThis as any).chrome.tabs.remove).toHaveBeenCalledTimes(2);
  });
});
