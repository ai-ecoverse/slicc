import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hosted leader tab proxies S3 / DA mount sign-and-forward over a
// `mount.sign-and-forward` externally_connectable Port (chrome.storage is
// unreachable from a non-extension origin; DA carries a transient IMS bearer
// the SW forwards). Pin-gated by the SAME three-factor pin as the CDP bridge,
// fetch proxy, and secrets.crud Port (EXT8). Mirrors
// `service-worker-secrets-crud-port.test.ts`.

const LEADER_TAB_ID = 42;
const PINNED_SENDER = {
  origin: 'https://www.sliccy.ai',
  tab: { id: LEADER_TAB_ID },
  frameId: 0,
};

describe('service-worker mount.sign-and-forward external Port', () => {
  let externalConnectListeners: ((port: any) => void)[];
  let storageMap: Record<string, string>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    externalConnectListeners = [];
    storageMap = {
      's3.aws.access_key_id': 'AKIDEXAMPLE',
      's3.aws.secret_access_key': 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      's3.aws.region': 'us-east-1',
    };
    (globalThis as any).chrome = {
      runtime: {
        onConnect: { addListener: vi.fn() },
        onConnectExternal: { addListener: (fn: any) => externalConnectListeners.push(fn) },
        onMessage: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        onStartup: { addListener: vi.fn() },
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
          set: vi.fn(async () => undefined),
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function connectPort(sender: any) {
    const messageListeners: ((raw: any) => void)[] = [];
    const posted: any[] = [];
    const port = {
      name: 'mount.sign-and-forward',
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

  it('forwards a configured S3 request via fetch for a pinned sender, posting { id, response }', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { etag: '"e1"' } })
    ) as unknown as typeof fetch;
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);

    await dispatch(conn, {
      id: 1,
      type: 'mount.s3-sign-and-forward',
      envelope: { profile: 'aws', method: 'GET', bucket: 'my-bucket', key: 'foo.txt' },
    });

    const reply = conn.posted.find((m) => m.id === 1);
    expect(reply.response.ok).toBe(true);
    expect(reply.response.status).toBe(200);
    expect(atob(reply.response.bodyBase64)).toBe(String.fromCharCode(1, 2, 3));
  });

  it('returns profile_not_configured (not a crash) when chrome.storage has no credentials', async () => {
    storageMap = {};
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);

    await dispatch(conn, {
      id: 2,
      type: 'mount.s3-sign-and-forward',
      envelope: { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
    });

    const reply = conn.posted.find((m) => m.id === 2);
    expect(reply.response.ok).toBe(false);
    expect(reply.response.errorCode).toBe('profile_not_configured');
  });

  it('replies invalid request and never signs for a malformed envelope (pinned sender)', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort(PINNED_SENDER);
    await dispatch(conn, { id: 3, type: 'mount.s3-sign-and-forward' });
    const reply = conn.posted.find((m) => m.id === 3);
    expect(reply.response.ok).toBe(false);
    expect(reply.response.error).toContain('invalid mount.sign-and-forward request');
  });

  it('replies with a pin error and never reaches chrome.storage for a forbidden sender', async () => {
    await import('../src/service-worker.js');
    const conn = connectPort({ origin: 'https://evil.example.com', tab: { id: 99 }, frameId: 0 });
    const localGet = (globalThis as any).chrome.storage.local.get as ReturnType<typeof vi.fn>;
    localGet.mockClear();

    await dispatch(conn, {
      id: 9,
      type: 'mount.s3-sign-and-forward',
      envelope: { profile: 'aws', method: 'GET', bucket: 'b', key: 'k' },
    });

    const reply = conn.posted.find((m) => m.id === 9);
    expect(reply.response.ok).toBe(false);
    expect(reply.response.error).toMatch(/mount\.sign-and-forward pin failed/);
    expect(localGet).not.toHaveBeenCalled();
  });
});
