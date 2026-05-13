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

  it('runs the reconciler when onStartup or onInstalled fires', async () => {
    // Boot with empty storage first; reconciler does default unlock.
    await loadSw();
    expect(onStartupListeners.length).toBeGreaterThanOrEqual(1);
    expect(onInstalledListeners.length).toBeGreaterThanOrEqual(1);

    // Now simulate a state change happening while the SW is alive,
    // and fire each listener. Each should re-run the reconciler.
    sessionStorage.set('slicc.detached.tabId', 77);
    tabsStore.set(77, {
      id: 77,
      windowId: 200,
      url: 'chrome-extension://test/index.html?detached=1',
    });
    sidePanelCalls.length = 0;

    onStartupListeners[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });

    // onInstalled should produce the same effect.
    sidePanelCalls.length = 0;
    onInstalledListeners[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });
  });
});

describe('detached popout — claim handler', () => {
  beforeEach(() => {
    resetMocks();
  });

  function sendClaim(tabId: number, url: string): void {
    const env = {
      source: 'panel',
      payload: { type: 'detached-claim' },
    };
    const sender = { tab: { id: tabId }, url };
    for (const listener of onMessageListeners) {
      listener(env, sender, () => {});
    }
  }

  it('locks on first claim from a valid detached URL', async () => {
    await loadSw();
    sidePanelCalls.length = 0;

    tabsStore.set(7, { id: 7, windowId: 100 });
    sendClaim(7, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(7);
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
      source: 'service-worker',
      payload: { type: 'detached-active' },
    });
  });

  it('accepts pathname / as well as /index.html', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(8, { id: 8, windowId: 100 });

    sendClaim(8, 'chrome-extension://test/?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(8);
  });

  it('rejects claim with missing sender.url', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(9, { id: 9, windowId: 100 });

    const env = {
      source: 'panel',
      payload: { type: 'detached-claim' },
    };
    for (const listener of onMessageListeners) {
      listener(env, { tab: { id: 9 } }, () => {});
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('rejects claim from a wrong-origin URL', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(10, { id: 10, windowId: 100 });

    sendClaim(10, 'https://evil.example.com/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('rejects claim missing the detached=1 searchParam', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(11, { id: 11, windowId: 100 });

    sendClaim(11, 'chrome-extension://test/index.html');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('treats a same-tab reclaim as idempotent', async () => {
    sessionStorage.set('slicc.detached.tabId', 12);
    tabsStore.set(12, { id: 12, windowId: 100 });
    await loadSw();
    sidePanelCalls.length = 0;
    mockChrome.runtime.sendMessage.mockClear();

    sendClaim(12, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(12);
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('closes the new tab and focuses the existing one when a different detached already exists', async () => {
    sessionStorage.set('slicc.detached.tabId', 20);
    tabsStore.set(20, { id: 20, windowId: 100 });
    tabsStore.set(21, { id: 21, windowId: 200 });
    await loadSw();

    sendClaim(21, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(21);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(20, { active: true });
    expect(mockChrome.windows.update).toHaveBeenCalledWith(100, { focused: true });
  });
});

describe('detached popout — popout-request handler', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('creates the detached tab with ?detached=1 active and does not lock yet', async () => {
    await loadSw();
    sidePanelCalls.length = 0;

    const env = {
      source: 'panel',
      payload: { type: 'detached-popout-request' },
    };
    for (const listener of onMessageListeners) {
      listener(env, {}, () => {});
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html?detached=1',
      active: true,
    });
    // The lock is set by the new tab's claim, not by tab creation.
    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });
});

describe('detached popout — action.onClicked', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('focuses the detached tab and window when stored tab is alive', async () => {
    sessionStorage.set('slicc.detached.tabId', 30);
    tabsStore.set(30, { id: 30, windowId: 555 });
    await loadSw();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(30, { active: true });
    expect(mockChrome.windows.update).toHaveBeenCalledWith(555, { focused: true });
    expect(mockChrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it('recovers and opens side panel when stored tab is gone', async () => {
    sessionStorage.set('slicc.detached.tabId', 99); // not in tabsStore
    await loadSw();
    sidePanelCalls.length = 0;

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('skips sidePanel.open when clickedTab.id is undefined', async () => {
    sessionStorage.set('slicc.detached.tabId', 88); // gone
    await loadSw();
    mockChrome.sidePanel.open.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: undefined, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.sidePanel.open).not.toHaveBeenCalled();
    // Cleanup still runs.
    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });
});
