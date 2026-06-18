/**
 * Tests for the leader-tab state machine in service-worker.ts (Wave 3b).
 *
 * Focuses on reconcileLeaderTabOnBoot, ensureLeaderTab,
 * action.onClicked leader-focus path, and tabs.onRemoved cleanup.
 * Mirrors the detached-popout suite — the leader-tab lifecycle was
 * intentionally modeled on the same MV3 SW eviction + storage.session
 * pattern.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStorage = new Map<string, unknown>();
const tabsStore = new Map<
  number,
  { id: number; windowId?: number; url?: string; pinned?: boolean }
>();
const tabsRemoved: number[] = [];

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
    setPanelBehavior: vi.fn(async () => {}),
    setOptions: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  },
  tabs: {
    get: vi.fn(async (id: number) => {
      const t = tabsStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    }),
    create: vi.fn(async ({ url, pinned }: { url: string; active?: boolean; pinned?: boolean }) => {
      const id = Math.max(0, ...tabsStore.keys()) + 1;
      const tab = { id, url, windowId: 100, pinned: pinned ?? false };
      tabsStore.set(id, tab);
      return tab;
    }),
    update: vi.fn(async (id: number, _props: unknown) => tabsStore.get(id)),
    remove: vi.fn(async (id: number) => {
      tabsStore.delete(id);
      tabsRemoved.push(id);
    }),
    query: vi.fn(async (_filter: { url?: string }) => [] as Array<{ id?: number; url?: string }>),
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
    getAll: vi.fn(async () => []),
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
    getContexts: vi.fn(async () => []),
    onConnect: { addListener: vi.fn() },
    onConnectExternal: { addListener: vi.fn() },
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
  notifications: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  webRequest: {
    onHeadersReceived: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn(async () => undefined),
  },
};

(globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

const LEADER_KEY = 'slicc_leader_tab_id';
const LEADER_URL = 'https://www.sliccy.ai/?slicc=leader';

function resetMocks(): void {
  sessionStorage.clear();
  tabsStore.clear();
  tabsRemoved.length = 0;
  onStartupListeners.length = 0;
  onInstalledListeners.length = 0;
  onMessageListeners.length = 0;
  actionClickListeners.length = 0;
  tabsRemovedListeners.length = 0;
  for (const fn of Object.values(mockChrome.tabs)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  for (const fn of Object.values(mockChrome.windows)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  for (const fn of Object.values(mockChrome.sidePanel)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  (mockChrome.tabs.query as ReturnType<typeof vi.fn>).mockImplementation(
    async (_filter: { url?: string }) => [] as Array<{ id?: number; url?: string }>
  );
}

async function loadSw(): Promise<void> {
  vi.resetModules();
  await import('../src/service-worker.js');
  // Allow the top-level reconcile…OnBoot() promises to settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireOnStartup(): Promise<void> {
  for (const cb of onStartupListeners) cb();
  // Two ticks: reconcile resolves, then ensureLeaderTab's chained .then runs.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function fireOnInstalled(): Promise<void> {
  for (const cb of onInstalledListeners) cb();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('leader tab — boot reconciliation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('does NOT auto-create the leader tab on top-level SW startup', async () => {
    await loadSw();
    // Reconcile-only at top-level: MV3 SW eviction recovery must not
    // spawn a duplicate pinned tab every time the SW wakes back up.
    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });

  it('keeps stored leader tab id when the tab is alive at the leader URL', async () => {
    sessionStorage.set(LEADER_KEY, 42);
    tabsStore.set(42, { id: 42, windowId: 100, url: LEADER_URL });

    await loadSw();

    expect(sessionStorage.get(LEADER_KEY)).toBe(42);
  });

  it('clears stale storage when the stored leader tab is gone', async () => {
    sessionStorage.set(LEADER_KEY, 99);
    // tabsStore does not contain 99.

    await loadSw();

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });

  it('clears stale storage when the stored tab has navigated away from the leader URL', async () => {
    sessionStorage.set(LEADER_KEY, 77);
    tabsStore.set(77, { id: 77, windowId: 100, url: 'https://other.example.com/' });

    await loadSw();

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });

  it('treats bare-host sliccy.ai (no slicc=leader query) as invalid', async () => {
    sessionStorage.set(LEADER_KEY, 55);
    tabsStore.set(55, { id: 55, windowId: 100, url: 'https://www.sliccy.ai/' });

    await loadSw();

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });
});

describe('leader tab — ensure on lifecycle events', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('creates a pinned leader tab on onInstalled when none exists', async () => {
    await loadSw();
    await fireOnInstalled();

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL,
      active: false,
      pinned: true,
    });
    const storedId = sessionStorage.get(LEADER_KEY) as number;
    expect(typeof storedId).toBe('number');
    expect(tabsStore.has(storedId)).toBe(true);
  });

  it('creates a pinned leader tab on onStartup when none exists', async () => {
    await loadSw();
    await fireOnStartup();

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL,
      active: false,
      pinned: true,
    });
    expect(sessionStorage.has(LEADER_KEY)).toBe(true);
  });

  it('adopts a Chrome-restored leader tab instead of spawning a duplicate', async () => {
    // Browser restart with "Continue where you left off": storage.session is
    // wiped, but the previous pinned sliccy.ai tab is restored. The SW must
    // adopt that tab id rather than create a second pinned tab.
    tabsStore.set(7, { id: 7, windowId: 100, url: LEADER_URL });
    (mockChrome.tabs.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (_filter: { url?: string }) => [{ id: 7, url: LEADER_URL }]
    );

    await loadSw();
    await fireOnStartup();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(7);
  });

  it('does not create a duplicate when the stored leader tab is already alive', async () => {
    sessionStorage.set(LEADER_KEY, 11);
    tabsStore.set(11, { id: 11, windowId: 100, url: LEADER_URL });

    await loadSw();
    await fireOnInstalled();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(11);
  });

  it('re-creates after the stored tab has been removed and lifecycle fires again', async () => {
    sessionStorage.set(LEADER_KEY, 3);
    tabsStore.set(3, { id: 3, windowId: 100, url: LEADER_URL });

    await loadSw();

    // User closes the leader tab.
    tabsStore.delete(3);
    for (const cb of tabsRemovedListeners) {
      cb(3, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.has(LEADER_KEY)).toBe(false);

    // Browser restart → onStartup fires → ensure brings the tab back.
    await fireOnStartup();
    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL,
      active: false,
      pinned: true,
    });
    expect(sessionStorage.has(LEADER_KEY)).toBe(true);
  });
});

describe('leader tab — action.onClicked', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('focuses the leader tab when no detached popout is locked', async () => {
    sessionStorage.set(LEADER_KEY, 21);
    tabsStore.set(21, { id: 21, windowId: 555, url: LEADER_URL });
    await loadSw();
    mockChrome.tabs.update.mockClear();
    mockChrome.windows.update.mockClear();
    mockChrome.sidePanel.open.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(21, { active: true });
    expect(mockChrome.windows.update).toHaveBeenCalledWith(555, { focused: true });
    expect(mockChrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it('detached popout takes precedence over the leader tab', async () => {
    // Both are stored and alive. During the Wave 6 transition the detached
    // path must continue to win — `service-worker-detached.test.ts` exercises
    // the same expectation without a leader tab present.
    sessionStorage.set('slicc.detached.tabId', 30);
    sessionStorage.set(LEADER_KEY, 21);
    tabsStore.set(30, {
      id: 30,
      windowId: 555,
      url: 'chrome-extension://test/index.html?detached=1',
    });
    tabsStore.set(21, { id: 21, windowId: 777, url: LEADER_URL });
    await loadSw();
    mockChrome.tabs.update.mockClear();
    mockChrome.windows.update.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(30, { active: true });
    expect(mockChrome.tabs.update).not.toHaveBeenCalledWith(21, { active: true });
  });

  it('falls back to side panel when the stored leader tab is gone', async () => {
    // detached not set, leader stored but dead → side-panel fallback.
    sessionStorage.set(LEADER_KEY, 88);
    // tabsStore does not contain 88.
    await loadSw();
    mockChrome.sidePanel.open.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('clears stale leader id and falls back to side panel when the tab navigated away', async () => {
    sessionStorage.set(LEADER_KEY, 12);
    tabsStore.set(12, { id: 12, windowId: 100, url: 'https://www.example.com/' });
    await loadSw();
    mockChrome.sidePanel.open.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });
});

describe('leader tab — tabs.onRemoved', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('clears the stored leader id when the leader tab is removed', async () => {
    sessionStorage.set(LEADER_KEY, 50);
    tabsStore.set(50, { id: 50, windowId: 100, url: LEADER_URL });
    await loadSw();

    for (const cb of tabsRemovedListeners) {
      cb(50, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });

  it('does nothing when an unrelated tab is removed', async () => {
    sessionStorage.set(LEADER_KEY, 60);
    tabsStore.set(60, { id: 60, windowId: 100, url: LEADER_URL });
    await loadSw();

    for (const cb of tabsRemovedListeners) {
      cb(999, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get(LEADER_KEY)).toBe(60);
  });
});
