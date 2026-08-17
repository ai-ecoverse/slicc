import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hosted leader tab proxies secrets CRUD over a `secrets.crud`
// externally_connectable Port (chrome.storage is unreachable from a non-extension
// origin). The Port is pin-gated by the SAME three-factor pin as the CDP bridge.

const LEADER_TAB_ID = 42;
const PINNED_SENDER = {
  origin: 'https://www.sliccy.ai',
  tab: { id: LEADER_TAB_ID },
  frameId: 0,
};

describe('service-worker secrets.crud external Port', () => {
  let externalConnectListeners: ((port: any) => void)[];
  let storageMap: Record<string, string>;

  beforeEach(() => {
    externalConnectListeners = [];
    storageMap = {
      GITHUB_TOKEN: 'ghp_realtoken',
      GITHUB_TOKEN_DOMAINS: 'api.github.com',
      'oauth.github.token': 'gh_oauth_real',
      'oauth.github.token_DOMAINS': 'github.com,api.github.com',
    };
    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: vi.fn() },
        onConnectExternal: { addListener: (fn: any) => externalConnectListeners.push(fn) },
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
        onUpdateAvailable: { addListener: vi.fn() },
        reload: vi.fn(),
        getContexts: vi.fn(async () => []),
        id: 'test-id',
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (key == null) return { ...storageMap };
            if (typeof key === 'string') return key in storageMap ? { [key]: storageMap[key] } : {};
            const out: Record<string, string> = {};
            for (const k of key as string[]) if (k in storageMap) out[k] = storageMap[k];
            return out;
          }),
          set: vi.fn(async (obj: Record<string, string>) => Object.assign(storageMap, obj)),
          remove: vi.fn(async () => undefined),
        },
        session: {
          get: vi.fn(async (key?: string) =>
            key === 'slicc_leader_tab_id' ? { slicc_leader_tab_id: LEADER_TAB_ID } : {}
          ),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      action: {
        setBadgeText: vi.fn(),
        setBadgeBackgroundColor: vi.fn(),
        onClicked: { addListener: vi.fn() },
      },
      sidePanel: {
        setPanelBehavior: vi.fn(async () => {}),
        setOptions: vi.fn(async () => {}),
        open: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(),
        reload: vi.fn(async () => {}),
        remove: vi.fn(),
        group: vi.fn(),
        onCreated: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      tabGroups: { update: vi.fn() },
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        sendCommand: vi.fn(),
        onEvent: { addListener: vi.fn() },
        onDetach: { addListener: vi.fn() },
      },
      identity: { launchWebAuthFlow: vi.fn(), getRedirectURL: vi.fn() },
      notifications: { create: vi.fn(), onClicked: { addListener: vi.fn() } },
      webRequest: { onHeadersReceived: { addListener: vi.fn() } },
    };
    (globalThis as any).WebSocket = class {
      addEventListener() {}
      send() {}
      close() {}
    };
    vi.resetModules();
  });

  function connectPort(sender: any) {
    const messageListeners: ((raw: any) => void)[] = [];
    const posted: any[] = [];
    const port = {
      name: 'secrets.crud',
      sender,
      onMessage: { addListener: (fn: any) => messageListeners.push(fn) },
      onDisconnect: { addListener: vi.fn() },
      postMessage: (m: any) => posted.push(m),
    };
    externalConnectListeners.forEach((l) => {
      l(port);
    });
    expect(messageListeners.length).toBeGreaterThan(0);
    return { messageListeners, posted };
  }

  async function dispatch(conn: { messageListeners: ((raw: any) => void)[] }, msg: any) {
    conn.messageListeners.forEach((l) => {
      l(msg);
    });
    await new Promise((r) => setTimeout(r, 40));
  }

  it('dispatches secrets handlers for a pinned sender and posts back { id, response }', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);

    await dispatch(conn, { id: 1, type: 'secrets.list-masked-entries' });
    await dispatch(conn, { id: 2, type: 'secrets.mask-oauth-token', providerId: 'github' });
    await dispatch(conn, { id: 3, type: 'secrets.scrub-tool-result', text: 'x ghp_realtoken y' });

    const masked = conn.posted.find((m) => m.id === 1);
    expect(Array.isArray(masked.response.entries)).toBe(true);
    expect(masked.response.entries.some((e: any) => e.name === 'GITHUB_TOKEN')).toBe(true);

    const oauth = conn.posted.find((m) => m.id === 2);
    expect(typeof oauth.response.maskedValue).toBe('string');
    expect(oauth.response.maskedValue.length).toBeGreaterThan(0);

    const scrub = conn.posted.find((m) => m.id === 3);
    expect(typeof scrub.response.text).toBe('string');
    expect(scrub.response.text).not.toContain('ghp_realtoken');
    expect(conn.posted).toHaveLength(3);
    for (const id of [1, 2, 3]) {
      expect(conn.posted.filter((m) => m.id === id)).toHaveLength(1);
    }
  });

  it('fails scrub closed with one correlated reply and no request text in the response or log', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    const requestText = 'private tool result';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as any).chrome.storage.local.get = vi.fn(async () => {
      throw new Error(requestText);
    });

    await dispatch(conn, { id: 4, type: 'secrets.scrub-tool-result', text: requestText });

    expect(conn.posted).toEqual([{ id: 4, response: { error: 'secret scrub failed' } }]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(requestText);
    errorSpy.mockRestore();
  });

  it('does not echo a missing secret name and replies exactly once', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    const requestedName = 'PRIVATE_SECRET_NAME';

    await dispatch(conn, {
      id: 5,
      type: 'secrets.set-domains',
      name: requestedName,
      domains: ['example.com'],
    });

    expect(conn.posted).toEqual([{ id: 5, response: { ok: false, error: 'secret not found' } }]);
    expect(JSON.stringify(conn.posted)).not.toContain(requestedName);
  });

  it('does not log an OAuth-derived name when a just-written entry is missing', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    const providerId = 'private-provider';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (globalThis as any).chrome.storage.local.set = vi.fn(async () => {});

    await dispatch(conn, {
      id: 6,
      type: 'secrets.mask-oauth-token',
      providerId,
      accessToken: 'placeholder',
      domains: 'example.com',
    });

    expect(conn.posted).toEqual([
      {
        id: 6,
        response: { maskedValue: undefined, error: 'entry missing after write' },
      },
    ]);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(providerId);
    warnSpy.mockRestore();
  });

  it.each([
    { id: 10, type: 'secrets.scrub-tool-result' },
    { id: 11, type: 'secrets.set' },
    { id: 12, type: 'secrets.delete' },
    { id: 13, type: 'secrets.session.set' },
    { id: 14, type: 'secrets.peek' },
    { id: 15, type: 'secrets.set-domains' },
    { id: 16, type: 'secrets.mask-oauth-token' },
    { id: 17, type: 'secrets.redact-export' },
  ])('immediately replies once for malformed known request $type', async ({ id, type }) => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);

    await dispatch(conn, { id, type, privateField: 'input-must-not-be-echoed' });

    expect(conn.posted).toEqual([
      { id, response: { error: `malformed secrets request: ${type}` } },
    ]);
  });

  it('rejects an unknown secrets type for a pinned sender without invoking a handler', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    await dispatch(conn, { id: 7, type: 'secrets.does-not-exist' });
    const replies = conn.posted.filter((m) => m.id === 7);
    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply.response.error).toBe('unknown secrets type: secrets.does-not-exist');
  });

  it('dispatches secrets.redact-export over the Port and returns { texts, redactionCount }', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    await dispatch(conn, {
      id: 8,
      type: 'secrets.redact-export',
      texts: ['no secrets here'],
    });
    const reply = conn.posted.find((m) => m.id === 8);
    expect(reply).toBeDefined();
    expect(Array.isArray(reply.response.texts)).toBe(true);
    expect(reply.response.texts).toHaveLength(1);
    expect(typeof reply.response.redactionCount).toBe('number');
    expect(reply.response.error).toBeUndefined();
  });

  it('replies with a pin error and never reaches a handler for a forbidden sender', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort({ origin: 'https://evil.example.com', tab: { id: 99 }, frameId: 0 });
    const localGet = (globalThis as any).chrome.storage.local.get as ReturnType<typeof vi.fn>;
    localGet.mockClear();

    await dispatch(conn, { id: 9, type: 'secrets.list-masked-entries' });

    const replies = conn.posted.filter((m) => m.id === 9);
    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply.response.error).toMatch(/secrets\.crud pin failed/);
    expect(reply.response.entries).toBeUndefined();
    // The handler (which builds the pipeline from chrome.storage.local) never ran.
    expect(localGet).not.toHaveBeenCalled();
  });
});
