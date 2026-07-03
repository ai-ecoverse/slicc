/**
 * Tests for the leader-tab state machine in service-worker.ts (Wave 3b).
 *
 * Focuses on reconcileLeaderTabOnBoot, ensureLeaderTab,
 * action.onClicked leader-focus path, and tabs.onRemoved cleanup.
 *
 * After the Wave 9a thin-extension strip the leader tab is the only
 * UI surface — there is no side panel or detached popout fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_BRIDGE_PORT_NAME } from '../../webapp/src/cdp/extension-bridge-protocol.js';

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
const actionClickListeners: Array<
  (tab: { id: number | undefined; windowId?: number; url?: string }) => void
> = [];
const tabsRemovedListeners: Array<
  (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void
> = [];
const onConnectExternalListeners: Array<(port: unknown) => void> = [];

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
  scripting: {
    executeScript: vi.fn(async () => [] as Array<{ result?: unknown }>),
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
    onConnect: { addListener: vi.fn() },
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
const LEADER_URL = 'https://www.sliccy.ai/?slicc=leader';
// The SW appends its own extension id (`?ext=<id>`) to the created tab URL so
// the leader page can open the bridge Port back. `chrome.runtime.id` is
// `'test-ext'` in the mock above.
const LEADER_URL_WITH_EXT = 'https://www.sliccy.ai/?slicc=leader&ext=test-ext';

function resetMocks(): void {
  sessionStorage.clear();
  tabsStore.clear();
  tabsRemoved.length = 0;
  onStartupListeners.length = 0;
  onInstalledListeners.length = 0;
  onMessageListeners.length = 0;
  actionClickListeners.length = 0;
  tabsRemovedListeners.length = 0;
  onConnectExternalListeners.length = 0;
  for (const fn of Object.values(mockChrome.tabs)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  for (const fn of Object.values(mockChrome.windows)) {
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
      url: LEADER_URL_WITH_EXT,
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
      url: LEADER_URL_WITH_EXT,
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

  it('reloads an adopted leader tab that lacks ext= so the page can open the bridge Port', async () => {
    // The restored tab matched isLeaderTabUrl (origin + slicc=leader) but has
    // no ext= param, so chrome.runtime.connect could never wire the bridge.
    // The SW must tabs.update it with ext= baked in (preserving the tab id)
    // before pinning, rather than leaving a dead leader tab.
    tabsStore.set(8, { id: 8, windowId: 100, url: LEADER_URL });
    (mockChrome.tabs.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (_filter: { url?: string }) => [{ id: 8, url: LEADER_URL }]
    );

    await loadSw();
    await fireOnStartup();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(8, { url: LEADER_URL_WITH_EXT });
    expect(sessionStorage.get(LEADER_KEY)).toBe(8);
  });

  it('does NOT reload an adopted leader tab that already carries the correct ext=', async () => {
    // No needless reload when the restored tab already has the matching ext=.
    tabsStore.set(9, { id: 9, windowId: 100, url: LEADER_URL_WITH_EXT });
    (mockChrome.tabs.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (_filter: { url?: string }) => [{ id: 9, url: LEADER_URL_WITH_EXT }]
    );

    await loadSw();
    await fireOnStartup();

    expect(mockChrome.tabs.create).not.toHaveBeenCalled();
    expect(mockChrome.tabs.update).not.toHaveBeenCalled();
    expect(sessionStorage.get(LEADER_KEY)).toBe(9);
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
  // __SLICC_EXT_DEV__ defaults to `false` in the chrome-extension vitest
  // project (see vitest.config.ts), so the resolver helpers are tested with
  // an explicit dev=true argument here instead of attempting to mutate the
  // module-level const (which is frozen by the time the module loads). The
  // resolver helpers feed the SW's LEADER_TAB_URL / LEADER_TAB_URL_GLOB /
  // isLeaderTabUrl origin check.
  let sw: typeof import('../src/service-worker.js');

  beforeEach(async () => {
    resetMocks();
    vi.resetModules();
    sw = await import('../src/service-worker.js');
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
    // The page posts its request immediately after connect; the handler
    // attaches synchronously and awaits the (pin-rejected) pipeline inside.
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
    // The bridge path posts handshake.rejected (its own pin-fail shape) — NOT
    // a fetch-proxy response-error. Confirms the branch routing.
    const kinds = port.posted.map((m) => (m as { kind?: string }).kind);
    expect(kinds).toContain('handshake.rejected');
    expect(port.posted.some((m) => (m as { type?: string }).type === 'response-error')).toBe(false);
  });
});
