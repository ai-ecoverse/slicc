import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import type { PageInfo } from '../../../src/cdp/types.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { TabHandle } from '../../../src/kernel/realm/realm-types.js';
import { TRAY_WORKER_STORAGE_KEY } from '../../../src/scoops/tray-runtime-config.js';

interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      realmListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      realmListeners.delete(h);
    },
  };
  const host: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      hostListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      hostListeners.delete(h);
    },
  };
  return { realm, host };
}

function makeNoopFs(): IFileSystem {
  const stub = async (): Promise<never> => {
    throw new Error('not implemented');
  };
  return {
    readFile: stub,
    readFileBuffer: stub,
    writeFile: stub,
    appendFile: stub,
    exists: async () => false,
    stat: stub as unknown as (p: string) => Promise<FsStat>,
    mkdir: stub,
    readdir: async () => [],
    rm: stub,
    cp: stub,
    mv: stub,
    resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
    getAllPaths: () => [],
    chmod: stub,
    symlink: stub,
    link: stub,
    readlink: stub,
    lstat: stub as unknown as (p: string) => Promise<FsStat>,
    realpath: async (p: string) => p,
    utimes: stub,
  } as unknown as IFileSystem;
}

function makeCtx(): CommandContext {
  return {
    fs: makeNoopFs(),
    cwd: '/workspace',
    env: new Map(),
    stdin: '',
  } as unknown as CommandContext;
}

interface MockBrowserState {
  pages: PageInfo[];
  cookies: Array<{ name: string; value: string }>;

  evalResults: Map<string, unknown>;

  localStorageStore: Map<string, string | null>;

  createdUrls: string[];

  attachedTargets: string[];
}

function makeMockBrowser(state: MockBrowserState): BrowserAPI {
  const api = {
    async listPages(): Promise<PageInfo[]> {
      return state.pages.slice();
    },
    async listAllTargets(): Promise<PageInfo[]> {
      return state.pages.slice();
    },
    async createPage(url?: string): Promise<string> {
      const id = `t-${state.createdUrls.length + 1}`;
      state.createdUrls.push(url ?? 'about:blank');
      state.pages.push({ targetId: id, url: url ?? 'about:blank', title: '' });
      return id;
    },

    async withTab<T>(targetId: string, fn: (tab: unknown) => Promise<T>): Promise<T> {
      state.attachedTargets.push(targetId);
      return fn({ targetId, sessionId: 'sess-1', evaluate, send: sendCDP });
    },
  };
  async function evaluate(expression: string): Promise<unknown> {
    const ls = /window\.localStorage\.getItem\(("[^"]*")\)/.exec(expression);
    if (ls) {
      const key = JSON.parse(ls[1]) as string;
      const value = state.localStorageStore.get(key);
      return value ?? null;
    }
    if (state.evalResults.has(expression)) return state.evalResults.get(expression);
    return undefined;
  }
  async function sendCDP(method: string): Promise<Record<string, unknown>> {
    if (method === 'Network.getCookies') {
      return { cookies: state.cookies.slice() };
    }
    throw new Error(`mock send: unhandled method ${method}`);
  }
  return api as unknown as BrowserAPI;
}

function makeBrowserState(overrides: Partial<MockBrowserState> = {}): MockBrowserState {
  return {
    pages: [],
    cookies: [],
    evalResults: new Map(),
    localStorageStore: new Map(),
    createdUrls: [],
    attachedTargets: [],
    ...overrides,
  };
}

function setup(state: MockBrowserState): { client: RealmRpcClient; dispose: () => void } {
  const ctx = makeCtx();
  const browser = makeMockBrowser(state);
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, ctx, { browser });
  const client = new RealmRpcClient(realm);
  return {
    client,
    dispose: () => {
      client.dispose();
      handle.dispose();
    },
  };
}

describe('realm RPC: browser channel — findTab', () => {
  it('resolves a tab by exact domain match', async () => {
    const state = makeBrowserState({
      pages: [
        { targetId: 't1', url: 'https://other.example/', title: 'Other' },
        { targetId: 't2', url: 'https://app.example.com/path', title: 'App' },
      ],
    });
    const { client, dispose } = setup(state);
    const hit = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'app.example.com' },
    ]);
    expect(hit?.targetId).toBe('t2');
    expect(hit?.url).toBe('https://app.example.com/path');
    dispose();
  });

  it('resolves a tab by urlMatch regex source', async () => {
    const state = makeBrowserState({
      pages: [
        { targetId: 't1', url: 'https://other.example/', title: 'Other' },
        { targetId: 't2', url: 'https://app.example.com/admin/users', title: 'Admin' },
      ],
    });
    const { client, dispose } = setup(state);
    const hit = await client.call<TabHandle | null>('browser', 'findTab', [
      { urlMatch: '/admin/' },
    ]);
    expect(hit?.targetId).toBe('t2');
    dispose();
  });

  it('returns null when no tab matches', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://other.example/', title: 'Other' }],
    });
    const { client, dispose } = setup(state);
    const hit = await client.call<TabHandle | null>('browser', 'findTab', [{ domain: 'nope.com' }]);
    expect(hit).toBeNull();
    dispose();
  });

  it('throws when query lacks domain or urlMatch', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await expect(client.call('browser', 'findTab', [{}])).rejects.toThrow(
      /domain.*urlMatch|urlMatch.*domain/
    );
    dispose();
  });
});

describe('realm RPC: browser channel — ensureTab', () => {
  it('returns an existing tab when origin matches', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://app.example.com/dashboard', title: 'D' }],
    });
    const { client, dispose } = setup(state);
    const handle = await client.call<TabHandle>('browser', 'ensureTab', [
      'https://app.example.com/other',
      {},
    ]);
    expect(handle.targetId).toBe('t1');
    expect(state.createdUrls).toEqual([]);
    dispose();
  });

  it('opens a new tab when nothing matches the origin', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 'tx', url: 'https://other.example/', title: 'X' }],
    });
    const { client, dispose } = setup(state);
    const handle = await client.call<TabHandle>('browser', 'ensureTab', [
      'https://app.example.com/dashboard',
      {},
    ]);
    expect(state.createdUrls).toEqual(['https://app.example.com/dashboard']);
    expect(handle.targetId).toBe('t-1');
    expect(handle.url).toBe('https://app.example.com/dashboard');
    dispose();
  });

  it('honors matchUrl regex when supplied', async () => {
    const state = makeBrowserState({
      pages: [
        { targetId: 't1', url: 'https://example.com/admin', title: 'A' },
        { targetId: 't2', url: 'https://example.com/user', title: 'U' },
      ],
    });
    const { client, dispose } = setup(state);
    const handle = await client.call<TabHandle>('browser', 'ensureTab', [
      'https://example.com/',
      { matchUrl: '/user$' },
    ]);
    expect(handle.targetId).toBe('t2');
    expect(state.createdUrls).toEqual([]);
    dispose();
  });
});

describe('realm RPC: browser channel — eval / evalAsync', () => {
  it('returns primitive eval values directly', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([['(() => 42)()', 42]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', '(() => 42)()']);
    expect(out).toBe(42);
    expect(state.attachedTargets).toContain('t1');
    dispose();
  });

  it('unwraps a single layer of JSON-stringified payload', async () => {
    const payload = { a: 1, b: ['c'] };
    const expr = "JSON.stringify({ a: 1, b: ['c'] })";
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([[expr, JSON.stringify(payload)]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', expr]);
    expect(out).toEqual(payload);
    dispose();
  });

  it('unwraps a double JSON.stringify wrap without JSON.parse(JSON.parse(...))', async () => {
    const payload = { ok: true };
    const expr = 'JSON.stringify(JSON.stringify({ ok: true }))';
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([[expr, JSON.stringify(JSON.stringify(payload))]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', expr]);
    expect(out).toEqual(payload);
    dispose();
  });

  it('leaves non-JSON strings alone (no false-positive parsing)', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([['(() => "hello world")()', 'hello world']]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', '(() => "hello world")()']);
    expect(out).toBe('hello world');
    dispose();
  });

  for (const literal of ['123', '-1.5', 'true', 'false', 'null']) {
    it(`preserves the string ${JSON.stringify(literal)} as-is`, async () => {
      const expr = `(() => ${JSON.stringify(literal)})()`;
      const state = makeBrowserState({
        pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
        evalResults: new Map([[expr, literal]]),
      });
      const { client, dispose } = setup(state);
      const out = await client.call('browser', 'eval', ['t1', expr]);
      expect(out).toBe(literal);
      dispose();
    });
  }

  it('unwraps a single intentional JSON.stringify of a string to the inner string', async () => {
    const expr = '(() => JSON.stringify("hello"))()';
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([[expr, JSON.stringify('hello')]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', expr]);
    expect(out).toBe('hello');
    dispose();
  });

  it('returns non-string CDP values unchanged (no JSON ceremony)', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map<string, unknown>([['(() => 42)()', 42]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'eval', ['t1', '(() => 42)()']);
    expect(out).toBe(42);
    dispose();
  });

  it('evalAsync awaits the promise and unwraps the resolved value', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      evalResults: new Map([['(async () => 7)()', 7]]),
    });
    const { client, dispose } = setup(state);
    const out = await client.call('browser', 'evalAsync', ['t1', '(async () => 7)()']);
    expect(out).toBe(7);
    dispose();
  });
});

describe('realm RPC: browser channel — cookie / localStorage', () => {
  it('returns cookie value by name', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      cookies: [
        { name: 'session', value: 'abc123' },
        { name: 'other', value: 'zzz' },
      ],
    });
    const { client, dispose } = setup(state);
    const v = await client.call<string | null>('browser', 'cookie', ['t1', 'session']);
    expect(v).toBe('abc123');
    dispose();
  });

  it('returns null for a missing cookie', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      cookies: [{ name: 'other', value: 'zzz' }],
    });
    const { client, dispose } = setup(state);
    const v = await client.call('browser', 'cookie', ['t1', 'missing']);
    expect(v).toBeNull();
    dispose();
  });

  it('reads localStorage via in-page evaluate', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      localStorageStore: new Map([['flag', '1']]),
    });
    const { client, dispose } = setup(state);
    const v = await client.call<string | null>('browser', 'localStorage', ['t1', 'flag']);
    expect(v).toBe('1');
    dispose();
  });

  it('returns null for missing localStorage keys', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 't1', url: 'https://x/', title: 'x' }],
      localStorageStore: new Map(),
    });
    const { client, dispose } = setup(state);
    const v = await client.call('browser', 'localStorage', ['t1', 'flag']);
    expect(v).toBeNull();
    dispose();
  });
});

describe('realm RPC: browser channel — error paths', () => {
  it('rejects when no browser is available in the realm host', async () => {
    const ctx = makeCtx();
    const { realm, host } = makePortPair();

    const original = (globalThis as { __slicc_browser?: unknown }).__slicc_browser;
    delete (globalThis as { __slicc_browser?: unknown }).__slicc_browser;
    const handle = attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    try {
      await expect(client.call('browser', 'findTab', [{ domain: 'x' }])).rejects.toThrow(
        /browser is not available/
      );
    } finally {
      client.dispose();
      handle.dispose();
      if (original !== undefined) {
        (globalThis as { __slicc_browser?: unknown }).__slicc_browser = original;
      }
    }
  });

  it('rejects unknown browser ops with a clear error', async () => {
    const { client, dispose } = setup(makeBrowserState());
    await expect(client.call('browser', 'unknownOp', [])).rejects.toThrow(/unknown browser op/);
    dispose();
  });
});

describe('realm RPC: browser channel — federated fleet listing', () => {
  let prevPanelRpc: unknown;
  let prevLocalStorage: unknown;

  beforeEach(() => {
    prevPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    prevLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  });

  afterEach(() => {
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = prevPanelRpc;
    (globalThis as { localStorage?: unknown }).localStorage = prevLocalStorage;
  });

  function installPanelRpc(impl: (op: string) => Promise<unknown>): ReturnType<typeof vi.fn> {
    const call = vi.fn(impl);
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call,
      onEvent: vi.fn(),
      registerPushTarget: vi.fn(),
      unregisterPushTarget: vi.fn(),
      dispose: vi.fn(),
    };
    return call;
  }

  function setTrayConfigured(configured: boolean): void {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) =>
        configured && key === TRAY_WORKER_STORAGE_KEY ? 'https://tray.example.com' : null,
    };
  }

  it('surfaces a follower tab (composite targetId) via findTab when a tray is configured', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 'local-1', url: 'https://local.example.com/', title: 'Local' }],
    });
    setTrayConfigured(true);
    const call = installPanelRpc(async (op) => {
      if (op === 'list-remote-targets') {
        return {
          targets: [
            {
              targetId: 'f-runtime:tab-7',
              url: 'https://follower.example.com/app',
              title: 'Follower',
            },
          ],
        };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const { client, dispose } = setup(state);
    const hit = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'follower.example.com' },
    ]);

    expect(hit?.targetId).toBe('f-runtime:tab-7');
    expect(hit?.url).toBe('https://follower.example.com/app');
    expect(call.mock.calls.map((c) => c[0])).toContain('list-remote-targets');
    dispose();
  });

  it('still resolves local tabs while merging follower tabs', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 'local-1', url: 'https://local.example.com/', title: 'Local' }],
    });
    setTrayConfigured(true);
    installPanelRpc(async () => ({
      targets: [
        { targetId: 'f-runtime:tab-7', url: 'https://follower.example.com/', title: 'Follower' },
      ],
    }));
    const { client, dispose } = setup(state);
    const local = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'local.example.com' },
    ]);
    expect(local?.targetId).toBe('local-1');
    dispose();
  });

  it('skips the panel-RPC supplement entirely when no tray is configured', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 'local-1', url: 'https://local.example.com/', title: 'Local' }],
    });
    setTrayConfigured(false);

    const call = installPanelRpc(async () => ({ targets: [] }));
    const { client, dispose } = setup(state);
    const local = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'local.example.com' },
    ]);
    expect(local?.targetId).toBe('local-1');

    const follower = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'follower.example.com' },
    ]);
    expect(follower).toBeNull();
    expect(call.mock.calls.map((c) => c[0])).not.toContain('list-remote-targets');
    dispose();
  });

  it('degrades to the local set when the panel-RPC supplement rejects', async () => {
    const state = makeBrowserState({
      pages: [{ targetId: 'local-1', url: 'https://local.example.com/', title: 'Local' }],
    });
    setTrayConfigured(true);
    installPanelRpc(async () => {
      throw new Error('bridge offline');
    });
    const { client, dispose } = setup(state);

    const local = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'local.example.com' },
    ]);
    expect(local?.targetId).toBe('local-1');

    const follower = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'follower.example.com' },
    ]);
    expect(follower).toBeNull();
    dispose();
  });

  it('dedupes a follower targetId already present in the local set', async () => {
    const state = makeBrowserState({
      pages: [
        { targetId: 'f-runtime:tab-7', url: 'https://follower.example.com/', title: 'Local copy' },
      ],
    });
    setTrayConfigured(true);
    installPanelRpc(async () => ({
      targets: [
        { targetId: 'f-runtime:tab-7', url: 'https://follower.example.com/', title: 'Remote copy' },
      ],
    }));
    const { client, dispose } = setup(state);
    const hit = await client.call<TabHandle | null>('browser', 'findTab', [
      { domain: 'follower.example.com' },
    ]);
    expect(hit?.targetId).toBe('f-runtime:tab-7');
    dispose();
  });
});
