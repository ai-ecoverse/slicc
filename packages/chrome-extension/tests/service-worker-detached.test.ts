/**
 * Tests for the detached popout state machine in service-worker.ts.
 *
 * Focuses on reconcileDetachedLockOnBoot, claim handler,
 * action.onClicked, tabs.onRemoved. The reconciler is the most
 * failure-prone path because of MV3 SW eviction interaction with
 * persistent setOptions vs non-persistent setPanelBehavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStorage = new Map<string, unknown>();
const sidePanelCalls: Array<{ method: string; args: unknown }> = [];
const tabsStore = new Map<number, { id: number; windowId?: number; url?: string }>();
const tabsRemoved: number[] = [];
const windowsStore: Array<{ id: number }> = [];

const onStartupListeners: Array<() => void> = [];
const onInstalledListeners: Array<() => void> = [];
const onMessageListeners: Array<
  (
    msg: unknown,
    sender: { tab?: { id: number }; url?: string },
    sendResponse: (response?: unknown) => void
  ) => void | boolean
> = [];
const actionClickListeners: Array<(tab: { id: number | undefined; windowId?: number }) => void> =
  [];
const tabsRemovedListeners: Array<
  (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void
> = [];

const mockChrome = {
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: sessionStorage.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) sessionStorage.set(k, v);
      }),
      remove: vi.fn(async (key: string) => {
        sessionStorage.delete(key);
      }),
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
  sidePanel: {
    setPanelBehavior: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'setPanelBehavior', args });
    }),
    setOptions: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'setOptions', args });
    }),
    open: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'open', args });
    }),
    close: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'close', args });
    }),
  },
  tabs: {
    get: vi.fn(async (id: number) => {
      const t = tabsStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    }),
    create: vi.fn(async ({ url }: { url: string }) => {
      const id = Math.max(0, ...tabsStore.keys()) + 1;
      const tab = { id, url, windowId: 100 };
      tabsStore.set(id, tab);
      return tab;
    }),
    update: vi.fn(async (id: number, _props: unknown) => tabsStore.get(id)),
    remove: vi.fn(async (id: number) => {
      tabsStore.delete(id);
      tabsRemoved.push(id);
    }),
    query: vi.fn(async () => []),
    group: vi.fn(async () => 1),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onRemoved: {
      addListener: (cb: (typeof tabsRemovedListeners)[number]) => {
        tabsRemovedListeners.push(cb);
      },
    },
  },
  windows: {
    update: vi.fn(async () => ({ id: 100 })),
    getAll: vi.fn(async () => windowsStore.slice()),
  },
  action: {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    onClicked: {
      addListener: (cb: (typeof actionClickListeners)[number]) => {
        actionClickListeners.push(cb);
      },
    },
  },
  runtime: {
    id: 'test-ext',
    getURL: (p: string) => `chrome-extension://test/${p}`,
    onStartup: {
      addListener: (cb: () => void) => {
        onStartupListeners.push(cb);
      },
    },
    onInstalled: {
      addListener: (cb: () => void) => {
        onInstalledListeners.push(cb);
      },
    },
    onMessage: {
      addListener: (cb: (typeof onMessageListeners)[number]) => {
        onMessageListeners.push(cb);
      },
    },
    sendMessage: vi.fn(async () => {}),
    onConnect: { addListener: vi.fn() },
    lastError: undefined,
  },
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
  },
  offscreen: {
    hasDocument: vi.fn(async () => true),
    createDocument: vi.fn(async () => {}),
  },
  identity: {
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: vi.fn(),
  },
  webRequest: {
    onHeadersReceived: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn(async () => undefined),
  },
};

(globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

function resetMocks(): void {
  sessionStorage.clear();
  sidePanelCalls.length = 0;
  tabsStore.clear();
  tabsRemoved.length = 0;
  windowsStore.length = 0;
  onStartupListeners.length = 0;
  onInstalledListeners.length = 0;
  onMessageListeners.length = 0;
  actionClickListeners.length = 0;
  tabsRemovedListeners.length = 0;
  for (const fn of Object.values(mockChrome.sidePanel)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  for (const fn of Object.values(mockChrome.tabs)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
}

async function loadSw(): Promise<void> {
  vi.resetModules();
  await import('../src/service-worker.js');
  // Allow the top-level reconcileDetachedLockOnBoot() promise to settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// If the dynamic import above throws "Cannot read properties of undefined
// (reading 'addListener')" or similar, the SW's existing top-level code
// touches a chrome.* surface this mock doesn't cover. Inspect the actual
// error stack; extend the mock with a no-op for the missing surface; rerun.
// The existing `packages/chrome-extension/tests/service-worker.test.ts`
// is a reference for the full chrome.* surface area the SW expects.

describe('detached popout — boot reconciliation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('applies default unlock state when storage is empty', async () => {
    await loadSw();
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: true },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: true },
    });
  });

  it('applies locked state when storage points to a live tab', async () => {
    sessionStorage.set('slicc.detached.tabId', 42);
    tabsStore.set(42, {
      id: 42,
      windowId: 100,
      url: 'chrome-extension://test/index.html?detached=1',
    });

    await loadSw();

    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });
  });

  it('clears stale storage and applies default when stored tab is gone', async () => {
    sessionStorage.set('slicc.detached.tabId', 99);
    // tabsStore does not contain 99.

    await loadSw();

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: true },
    });
  });
});
