/**
 * Tests for extension update handling in service-worker.ts.
 *
 * Verifies:
 * - onUpdateAvailable triggers chrome.runtime.reload()
 * - The leader tab is reloaded before the SW restart
 * - The update reload guard prevents rapid re-reloads
 * - A missing leader tab is tolerated
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStorage = new Map<string, unknown>();
const tabsStore = new Map<
  number,
  { id: number; windowId?: number; url?: string; pinned?: boolean }
>();

const onUpdateAvailableListeners: Array<(details: { version: string }) => void> = [];
const onStartupListeners: Array<() => void> = [];
const onInstalledListeners: Array<() => void> = [];
const onCreatedListeners: Array<(tab: { id?: number; url?: string; pinned?: boolean }) => void> =
  [];
const onUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string }) => void> = [];
const onMessageListeners: Array<
  (
    msg: unknown,
    sender: { tab?: { id: number }; url?: string },
    sendResponse: (response?: unknown) => void
  ) => void | boolean
> = [];
const actionClickListeners: Array<
  (tab: { id: number | undefined; windowId?: number; url?: string }) => void
> = [];
const tabsRemovedListeners: Array<
  (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void
> = [];
const onConnectExternalListeners: Array<(port: unknown) => void> = [];
const onConnectListeners: Array<(port: unknown) => void> = [];

function globMatches(glob: string | undefined, url: string | undefined): boolean {
  if (!glob) return true;
  const prefix = glob.endsWith('*') ? glob.slice(0, -1) : glob;
  return (url ?? '').startsWith(prefix);
}

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
    reload: vi.fn(async () => {}),
    remove: vi.fn(async (id: number) => {
      tabsStore.delete(id);
    }),
    query: vi.fn(async (filter: { url?: string }) =>
      [...tabsStore.values()].filter((t) => globMatches(filter?.url, t.url))
    ),
    group: vi.fn(async () => 1),
    onCreated: {
      addListener: (cb: (typeof onCreatedListeners)[number]) => {
        onCreatedListeners.push(cb);
      },
    },
    onUpdated: {
      addListener: (cb: (typeof onUpdatedListeners)[number]) => {
        onUpdatedListeners.push(cb);
      },
    },
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
  sidePanel: {
    setPanelBehavior: vi.fn(async () => {}),
    setOptions: vi.fn(async () => {}),
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
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
    reload: vi.fn(),
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
    onUpdateAvailable: {
      addListener: (cb: (details: { version: string }) => void) => {
        onUpdateAvailableListeners.push(cb);
      },
    },
    onMessage: {
      addListener: (cb: (typeof onMessageListeners)[number]) => {
        onMessageListeners.push(cb);
      },
    },
    sendMessage: vi.fn(async () => {}),
    getContexts: vi.fn(async () => []),
    onConnect: {
      addListener: (cb: (port: unknown) => void) => {
        onConnectListeners.push(cb);
      },
    },
    onConnectExternal: {
      addListener: (cb: (port: unknown) => void) => {
        onConnectExternalListeners.push(cb);
      },
    },
    lastError: undefined,
  },
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
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
const UPDATE_GUARD_KEY = 'slicc_update_reload_at';
const LEADER_URL = 'https://www.sliccy.ai/?slicc=leader';

function resetMocks(): void {
  sessionStorage.clear();
  tabsStore.clear();
  onUpdateAvailableListeners.length = 0;
  onStartupListeners.length = 0;
  onInstalledListeners.length = 0;
  onCreatedListeners.length = 0;
  onUpdatedListeners.length = 0;
  onMessageListeners.length = 0;
  actionClickListeners.length = 0;
  tabsRemovedListeners.length = 0;
  onConnectExternalListeners.length = 0;
  onConnectListeners.length = 0;
  for (const fn of Object.values(mockChrome.tabs)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  mockChrome.runtime.reload.mockClear();
  (mockChrome.tabs.query as ReturnType<typeof vi.fn>).mockImplementation(
    async (filter: { url?: string }) =>
      [...tabsStore.values()].filter((t) => globMatches(filter?.url, t.url))
  );
}

async function loadSw(): Promise<void> {
  vi.resetModules();
  await import('../src/service-worker.js');
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('extension update — onUpdateAvailable', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('registers an onUpdateAvailable listener on import', async () => {
    await loadSw();
    expect(onUpdateAvailableListeners).toHaveLength(1);
  });

  it('calls chrome.runtime.reload() when an update is available', async () => {
    await loadSw();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    // The handler is async — give it time to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });

  it('reloads the leader tab before reloading the SW', async () => {
    // Set up a stored leader tab.
    sessionStorage.set(LEADER_KEY, 42);
    tabsStore.set(42, { id: 42, windowId: 100, url: LEADER_URL });

    await loadSw();
    mockChrome.tabs.reload.mockClear();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockChrome.tabs.reload).toHaveBeenCalledWith(42);
    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });

  it('stamps the update reload guard in session storage after successful leader reload', async () => {
    sessionStorage.set(LEADER_KEY, 42);
    tabsStore.set(42, { id: 42, windowId: 100, url: LEADER_URL });

    await loadSw();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    const stamp = sessionStorage.get(UPDATE_GUARD_KEY);
    expect(typeof stamp).toBe('number');
    expect(stamp as number).toBeGreaterThan(0);
  });

  it('skips leader tab reload when guard window is active but still reloads SW', async () => {
    // Stamp the guard as if a recent reload happened.
    sessionStorage.set(UPDATE_GUARD_KEY, Date.now() - 10_000);
    sessionStorage.set(LEADER_KEY, 42);
    tabsStore.set(42, { id: 42, windowId: 100, url: LEADER_URL });

    await loadSw();
    mockChrome.tabs.reload.mockClear();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    // Leader tab NOT reloaded (guard active), but SW IS reloaded.
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });

  it('tolerates a missing leader tab — still reloads the SW', async () => {
    // No leader tab stored.
    await loadSw();
    mockChrome.tabs.reload.mockClear();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });

  it('still reloads SW if leader tab reload throws', async () => {
    sessionStorage.set(LEADER_KEY, 42);
    tabsStore.set(42, { id: 42, windowId: 100, url: LEADER_URL });

    await loadSw();
    // Make chrome.tabs.reload throw.
    mockChrome.tabs.reload.mockRejectedValueOnce(new Error('tab gone'));
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    // SW reload still happens via the catch fallback.
    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });

  it('does NOT stamp guard when leader tab reload fails (tab gone)', async () => {
    // No stored leader tab → reloadLeaderTabIfExists returns false.
    await loadSw();
    const listener = onUpdateAvailableListeners[0]!;

    listener({ version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));

    // Guard not stamped because the leader tab wasn't successfully reloaded.
    expect(sessionStorage.has(UPDATE_GUARD_KEY)).toBe(false);
    // But SW reload still happens.
    expect(mockChrome.runtime.reload).toHaveBeenCalled();
  });
});
