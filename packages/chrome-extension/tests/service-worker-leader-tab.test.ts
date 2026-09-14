import { EXTENSION_BRIDGE_PORT_NAME, EXTENSION_BRIDGE_PROTOCOL_VERSION } from '@slicc/shared-ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHERRY_PANEL_PORT_NAME } from '../src/cherry-panel-protocol.js';

const sessionStorage = new Map<string, unknown>();
const tabsStore = new Map<
  number,
  {
    id: number;
    windowId?: number;
    url?: string;
    pinned?: boolean;
    discarded?: boolean;
    status?: 'unloaded' | 'loading' | 'complete';
  }
>();
const tabsRemoved: number[] = [];

const onStartupListeners: Array<() => void> = [];
const onInstalledListeners: Array<() => void> = [];
const onCreatedListeners: Array<(tab: { id?: number; url?: string; pinned?: boolean }) => void> =
  [];
const onUpdatedListeners: Array<(tabId: number, changeInfo: { url?: string }) => void> = [];

function globMatches(glob: string | undefined, url: string | undefined): boolean {
  if (!glob) return true;
  const prefix = glob.endsWith('*') ? glob.slice(0, -1) : glob;
  return (url ?? '').startsWith(prefix);
}
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
      tabsRemoved.push(id);
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
    onUpdateAvailable: {
      addListener: vi.fn(),
    },
    reload: vi.fn(),
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
const LEADER_URL = 'https://www.sliccy.ai/?slicc=leader';

const LEADER_URL_WITH_EXT = 'https://www.sliccy.ai/?slicc=leader&ext=test-ext';

function resetMocks(): void {
  sessionStorage.clear();
  tabsStore.clear();
  tabsRemoved.length = 0;
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
  for (const fn of Object.values(mockChrome.windows)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
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

function leaderTabCount(): number {
  return [...tabsStore.values()].filter(
    (t) =>
      (t.url ?? '').startsWith('https://www.sliccy.ai/') && (t.url ?? '').includes('slicc=leader')
  ).length;
}

async function fireIconClick(windowId = 1): Promise<void> {
  const port = fakePanelPort();
  for (const cb of onConnectListeners) cb(port);
  port._rx({ kind: 'hello', windowId });
  await new Promise((r) => setTimeout(r, 20));
}

async function fireOnStartup(): Promise<void> {
  for (const cb of onStartupListeners) cb();

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

describe('leader tab — ensure on demand (icon click), never on startup', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('does NOT auto-create a leader tab on browser startup (no onStartup/onInstalled trigger)', async () => {
    await loadSw();
    expect(onStartupListeners).toHaveLength(0);
    expect(onInstalledListeners).toHaveLength(0);
    await fireOnStartup();
    await fireOnInstalled();
    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(sessionStorage.has(LEADER_KEY)).toBe(false);
  });

  it('creates a pinned leader tab on icon click when none is open', async () => {
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL_WITH_EXT,
      active: false,
      pinned: true,
    });
    const storedId = sessionStorage.get(LEADER_KEY) as number;
    expect(typeof storedId).toBe('number');
    expect(tabsStore.has(storedId)).toBe(true);

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(storedId, { autoDiscardable: false });
  });

  it('exempts an adopted leader tab from discard/freeze', async () => {
    tabsStore.set(7, { id: 7, windowId: 100, url: LEADER_URL_WITH_EXT, pinned: true });
    await loadSw();
    await fireIconClick();

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(7, { autoDiscardable: false });
  });

  it('adopts an existing leader tab on icon click instead of creating a duplicate', async () => {
    tabsStore.set(7, { id: 7, windowId: 100, url: LEADER_URL });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(7);
  });

  it('dedups multiple leader tabs down to one on icon click (heals prior accumulation)', async () => {
    for (const id of [4, 5, 6]) {
      tabsStore.set(id, { id, windowId: 100, url: LEADER_URL_WITH_EXT, pinned: true });
    }
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(5);
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(6);
    expect(mockChrome.tabs.remove).not.toHaveBeenCalledWith(4);
    expect(leaderTabCount()).toBe(1);
    expect(sessionStorage.get(LEADER_KEY)).toBe(4);
  });

  it('reloads + pins an adopted leader tab that lacks ext= so the page can open the bridge Port', async () => {
    tabsStore.set(8, { id: 8, windowId: 100, url: LEADER_URL, pinned: false });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(8, {
      pinned: true,
      url: LEADER_URL_WITH_EXT,
    });
    expect(sessionStorage.get(LEADER_KEY)).toBe(8);
  });

  it('pins an adopted leader tab that already has ext= but is unpinned (no reload)', async () => {
    tabsStore.set(12, { id: 12, windowId: 100, url: LEADER_URL_WITH_EXT, pinned: false });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(12, { pinned: true });
    expect(sessionStorage.get(LEADER_KEY)).toBe(12);
  });

  it('does NOT rewrite an adopted leader tab that already carries ext= and is pinned', async () => {
    tabsStore.set(9, { id: 9, windowId: 100, url: LEADER_URL_WITH_EXT, pinned: true });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    mockChrome.tabs.update.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();

    expect(mockChrome.tabs.update).toHaveBeenCalledTimes(1);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(9, { autoDiscardable: false });
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(9);
  });

  it('reloads an adopted leader tab that Chrome discarded (memory saver)', async () => {
    tabsStore.set(21, {
      id: 21,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      discarded: true,
      status: 'unloaded',
    });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.reload).toHaveBeenCalledWith(21);
    expect(sessionStorage.get(LEADER_KEY)).toBe(21);
  });

  it('reloads an adopted leader tab restored lazily by session restore (status unloaded)', async () => {
    tabsStore.set(22, {
      id: 22,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      status: 'unloaded',
    });
    await loadSw();
    await fireIconClick();

    expect(mockChrome.tabs.reload).toHaveBeenCalledWith(22);
    expect(sessionStorage.get(LEADER_KEY)).toBe(22);
  });

  it('does NOT double-load a discarded leader whose adoption already navigates it (ext= stamp)', async () => {
    tabsStore.set(23, {
      id: 23,
      windowId: 100,
      url: LEADER_URL,
      pinned: true,
      discarded: true,
      status: 'unloaded',
    });
    await loadSw();
    await fireIconClick();

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(23, {
      pinned: true,
      url: LEADER_URL_WITH_EXT,
    });
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(23);
  });

  it('prefers a live leader tab over a discarded duplicate when deduping', async () => {
    tabsStore.set(31, {
      id: 31,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      discarded: true,
      status: 'unloaded',
    });
    tabsStore.set(32, {
      id: 32,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      status: 'complete',
    });
    await loadSw();
    mockChrome.tabs.create.mockClear();
    await fireIconClick();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(31);
    expect(mockChrome.tabs.remove).not.toHaveBeenCalledWith(32);
    expect(mockChrome.tabs.reload).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(32);
  });

  it('still adopts (and reloads) when every leader duplicate is unloaded', async () => {
    tabsStore.set(41, {
      id: 41,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      discarded: true,
      status: 'unloaded',
    });
    tabsStore.set(42, {
      id: 42,
      windowId: 100,
      url: LEADER_URL_WITH_EXT,
      pinned: true,
      discarded: true,
      status: 'unloaded',
    });
    await loadSw();
    await fireIconClick();

    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(42);
    expect(mockChrome.tabs.reload).toHaveBeenCalledWith(41);
    expect(sessionStorage.get(LEADER_KEY)).toBe(41);
  });

  it('re-creates the leader tab on icon click after the user closed it', async () => {
    tabsStore.set(3, { id: 3, windowId: 100, url: LEADER_URL });
    sessionStorage.set(LEADER_KEY, 3);
    await loadSw();

    tabsStore.delete(3);
    for (const cb of tabsRemovedListeners) {
      cb(3, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(sessionStorage.has(LEADER_KEY)).toBe(false);

    mockChrome.tabs.create.mockClear();
    await fireIconClick();
    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL_WITH_EXT,
      active: false,
      pinned: true,
    });
    expect(sessionStorage.has(LEADER_KEY)).toBe(true);
  });
});

describe('leader tab — native side-panel toggle', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('registers the native side-panel toggle at init', async () => {
    await loadSw();
    expect(mockChrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
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

describe('leader tab — URL resolvers (dev vs prod)', () => {
  let sw: typeof import('../src/leader-tab-sw.js');

  beforeEach(async () => {
    resetMocks();
    vi.resetModules();
    sw = await import('../src/leader-tab-sw.js');
    await new Promise((r) => setTimeout(r, 0));
  });

  it('getLeaderTabUrl returns the hosted leader URL in production builds', () => {
    expect(sw.getLeaderTabUrl(false)).toBe('https://www.sliccy.ai/?slicc=leader');
  });

  it('getLeaderTabUrl returns the localhost wrangler leader URL in dev builds', () => {
    expect(sw.getLeaderTabUrl(true)).toBe('http://localhost:8787/?slicc=leader');
  });

  it('getLeaderTabUrlGlob returns the hosted tabs.query glob in production builds', () => {
    expect(sw.getLeaderTabUrlGlob(false)).toBe('https://www.sliccy.ai/*');
  });

  it('getLeaderTabUrlGlob returns the localhost wrangler glob in dev builds', () => {
    expect(sw.getLeaderTabUrlGlob(true)).toBe('http://localhost:8787/*');
  });

  it('getLeaderTabOrigin returns the hosted origin in production builds', () => {
    expect(sw.getLeaderTabOrigin(false)).toBe('https://www.sliccy.ai');
  });

  it('getLeaderTabOrigin returns the localhost wrangler origin in dev builds', () => {
    expect(sw.getLeaderTabOrigin(true)).toBe('http://localhost:8787');
  });

  it('appendLeaderExtIdParam adds the ext query param to the hosted leader URL', () => {
    expect(sw.appendLeaderExtIdParam('https://www.sliccy.ai/?slicc=leader', 'abc123')).toBe(
      'https://www.sliccy.ai/?slicc=leader&ext=abc123'
    );
  });

  it('appendLeaderExtIdParam adds the ext query param to the localhost dev leader URL', () => {
    expect(sw.appendLeaderExtIdParam('http://localhost:8787/?slicc=leader', 'devid')).toBe(
      'http://localhost:8787/?slicc=leader&ext=devid'
    );
  });

  it('appendLeaderExtIdParam overwrites a pre-existing ext param rather than duplicating it', () => {
    expect(
      sw.appendLeaderExtIdParam('https://www.sliccy.ai/?slicc=leader&ext=stale', 'fresh')
    ).toBe('https://www.sliccy.ai/?slicc=leader&ext=fresh');
  });

  it('appendLeaderExtIdParam returns the input unchanged when the URL cannot be parsed', () => {
    expect(sw.appendLeaderExtIdParam('not a url', 'abc123')).toBe('not a url');
  });

  it('appendLeaderExtIdParam returns the input unchanged when the extension id is absent', () => {
    expect(sw.appendLeaderExtIdParam('https://www.sliccy.ai/?slicc=leader', undefined)).toBe(
      'https://www.sliccy.ai/?slicc=leader'
    );
  });
});

interface FakeExternalPort {
  name: string;
  sender: { origin?: string; tab?: { id: number }; frameId?: number } | undefined;
  posted: unknown[];
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  emit: (msg: unknown) => void;
}

function makeExternalPort(name: string, sender: FakeExternalPort['sender']): FakeExternalPort {
  let msgFn: ((msg: unknown) => void) | null = null;
  const port: FakeExternalPort = {
    name,
    sender,
    posted: [],
    disconnect: vi.fn(),
    onMessage: { addListener: (fn) => (msgFn = fn) },
    onDisconnect: { addListener: () => {} },
    postMessage(msg: unknown) {
      port.posted.push(msg);
    },
    emit: (msg: unknown) => msgFn?.(msg),
  };
  return port;
}

describe('onConnectExternal — fetch-proxy.fetch branch', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('rejects a disallowed-origin leader with a response-error on the first request', async () => {
    await loadSw();
    const listener = onConnectExternalListeners[0];
    expect(listener).toBeDefined();

    const port = makeExternalPort('fetch-proxy.fetch', {
      origin: 'https://evil.example.com',
      tab: { id: 1 },
      frameId: 0,
    });
    listener(port);

    port.emit({ type: 'request', url: 'https://api.example/v1', method: 'GET', headers: {} });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const errors = port.posted.filter(
      (m): m is { type: string; error: string } =>
        !!m && typeof m === 'object' && (m as { type?: unknown }).type === 'response-error'
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('pin failed');
  });

  it('routes a bridge-named external port to the CDP bridge, not the fetch proxy', async () => {
    await loadSw();
    const listener = onConnectExternalListeners[0];
    const port = makeExternalPort(EXTENSION_BRIDGE_PORT_NAME, {
      origin: 'https://evil.example.com',
      tab: { id: 1 },
      frameId: 0,
    });
    listener(port);
    await new Promise((r) => setTimeout(r, 0));

    const kinds = port.posted.map((m) => (m as { kind?: string }).kind);
    expect(kinds).toContain('handshake.rejected');
    expect(port.posted.some((m) => (m as { type?: string }).type === 'response-error')).toBe(false);
  });
});

interface FakePanelPort {
  name: string;
  _sent: unknown[];
  _rx: (msg: unknown) => void;
  postMessage: (msg: unknown) => void;
  onMessage: { addListener: (cb: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
}

function fakePanelPort(): FakePanelPort {
  const msgs: unknown[] = [];
  let onMsg: ((m: unknown) => void) | undefined;
  return {
    name: CHERRY_PANEL_PORT_NAME,
    _sent: msgs,
    _rx: (m: unknown) => onMsg?.(m),
    postMessage: (m: unknown) => msgs.push(m),
    onMessage: { addListener: (cb: (m: unknown) => void) => (onMsg = cb) },
    onDisconnect: { addListener: () => {} },
  };
}

describe('cherry-panel port integration', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('a cherry-panel port connect ensures the leader and replays tri-state after hello', async () => {
    await loadSw();
    mockChrome.tabs.create.mockClear();
    const port = fakePanelPort();
    for (const cb of onConnectListeners) cb(port);
    port._rx({ kind: 'hello', windowId: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: LEADER_URL_WITH_EXT,
      active: false,
      pinned: true,
    });
    expect(port._sent).toContainEqual({ kind: 'join-url', state: 'booting' });
  });

  it('leader.join-url → setCherryPanelJoinUrl → panel ready', async () => {
    await loadSw();
    const panelPort = fakePanelPort();
    for (const cb of onConnectListeners) cb(panelPort);
    panelPort._rx({ kind: 'hello', windowId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const leaderTabId = [...tabsStore.keys()][0];
    expect(typeof leaderTabId).toBe('number');

    const bridgePort = makeExternalPort(EXTENSION_BRIDGE_PORT_NAME, {
      origin: 'https://www.sliccy.ai',
      tab: { id: leaderTabId },
      frameId: 0,
    });
    for (const cb of onConnectExternalListeners) cb(bridgePort);

    bridgePort.emit({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'c',
      kind: 'handshake.hello',
    });
    await new Promise((r) => setTimeout(r, 0));

    bridgePort.emit({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'c',
      kind: 'leader.join-url',
      joinUrl: 'https://worker.test/join/t.secret',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(panelPort._sent).toContainEqual({
      kind: 'join-url',
      state: 'ready',
      joinUrl: 'https://worker.test/join/t.secret',
    });
  });
});
