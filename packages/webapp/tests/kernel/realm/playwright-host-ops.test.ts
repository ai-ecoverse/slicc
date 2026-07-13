/**
 * Tests for the new browser dispatch ops added to `dispatchBrowser` for
 * the upcoming playwright shim: `createTab`, `closeTab`, `setViewport`,
 * `navigateTab`, `screenshotTab`, `waitForLoadState`.
 *
 * Mirrors the mocking approach in `browser-realm.test.ts` — a fake
 * `BrowserAPI` covering just the CDP-shaped surface these ops touch
 * (createPage/closePage/withTab/navigate/screenshot/evaluate/sendCDP),
 * driven through the realm RPC port pair so the dispatch path under
 * test is the real one the realm calls into.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../../src/cdp/browser-api.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';

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
  createdUrls: string[];
  closedTargets: string[];
  navigatedTargets: Array<{ targetId: string; url: string }>;
  attachedTargets: string[];
  viewportCalls: Array<{ method: string; params: Record<string, unknown> }>;
  screenshotOptions: Array<Record<string, unknown> | undefined>;
  /** Sequence of values returned by successive evaluate() calls (for networkidle polling). */
  evaluateSequence: unknown[];
  evaluateCallCount: number;
}

function makeMockBrowser(state: MockBrowserState): BrowserAPI {
  const api = {
    async createPage(url?: string): Promise<string> {
      const id = `t-${state.createdUrls.length + 1}`;
      state.createdUrls.push(url ?? 'about:blank');
      return id;
    },
    async closePage(targetId: string): Promise<void> {
      state.closedTargets.push(targetId);
    },
    async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
      state.attachedTargets.push(targetId);
      return fn('sess-1');
    },
    async navigate(url: string): Promise<void> {
      const targetId = state.attachedTargets[state.attachedTargets.length - 1];
      state.navigatedTargets.push({ targetId, url });
    },
    async screenshot(options?: Record<string, unknown>): Promise<string> {
      state.screenshotOptions.push(options);
      return 'base64-png-data';
    },
    async evaluate(): Promise<unknown> {
      const idx = state.evaluateCallCount++;
      return state.evaluateSequence[Math.min(idx, state.evaluateSequence.length - 1)];
    },
    async sendCDP(
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> {
      state.viewportCalls.push({ method, params });
      return {};
    },
  };
  return api as unknown as BrowserAPI;
}

function makeBrowserState(overrides: Partial<MockBrowserState> = {}): MockBrowserState {
  return {
    createdUrls: [],
    closedTargets: [],
    navigatedTargets: [],
    attachedTargets: [],
    viewportCalls: [],
    screenshotOptions: [],
    evaluateSequence: [true],
    evaluateCallCount: 0,
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

describe('realm RPC: browser channel — createTab / closeTab', () => {
  it('createTab returns the new targetId without attaching', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    const targetId = await client.call<string>('browser', 'createTab', ['https://example.com']);
    expect(targetId).toBe('t-1');
    expect(state.createdUrls).toEqual(['https://example.com']);
    expect(state.attachedTargets).toEqual([]);
    dispose();
  });

  it('createTab defaults to no url argument', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    const targetId = await client.call<string>('browser', 'createTab', []);
    expect(targetId).toBe('t-1');
    expect(state.createdUrls).toEqual(['about:blank']);
    dispose();
  });

  it('closeTab closes by targetId', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'closeTab', ['t-1']);
    expect(state.closedTargets).toEqual(['t-1']);
    dispose();
  });
});

describe('realm RPC: browser channel — navigateTab', () => {
  it('navigates the attached tab to a url', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'navigateTab', ['t-1', 'https://example.com/page']);
    expect(state.attachedTargets).toContain('t-1');
    expect(state.navigatedTargets).toEqual([{ targetId: 't-1', url: 'https://example.com/page' }]);
    dispose();
  });
});

describe('realm RPC: browser channel — screenshotTab', () => {
  it('returns a base64 PNG string', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    const png = await client.call<string>('browser', 'screenshotTab', ['t-1']);
    expect(png).toBe('base64-png-data');
    expect(state.attachedTargets).toContain('t-1');
    dispose();
  });

  it('forwards fullPage option', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'screenshotTab', ['t-1', { fullPage: true }]);
    expect(state.screenshotOptions[0]).toMatchObject({ fullPage: true });
    dispose();
  });
});

describe('realm RPC: browser channel — setViewport', () => {
  it('sends Emulation.setDeviceMetricsOverride with the requested size', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'setViewport', ['t-1', 800, 600]);
    expect(state.attachedTargets).toContain('t-1');
    expect(state.viewportCalls).toEqual([
      {
        method: 'Emulation.setDeviceMetricsOverride',
        params: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      },
    ]);
    dispose();
  });
});

describe('realm RPC: browser channel — waitForLoadState', () => {
  it('resolves immediately for "load"', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'waitForLoadState', ['t-1', 'load']);
    dispose();
  });

  it('resolves immediately for "domcontentloaded"', async () => {
    const state = makeBrowserState();
    const { client, dispose } = setup(state);
    await client.call('browser', 'waitForLoadState', ['t-1', 'domcontentloaded']);
    dispose();
  });

  it('polls via evaluate for "networkidle" until quiet', async () => {
    const state = makeBrowserState({
      // First poll: still busy. Second poll: idle.
      evaluateSequence: [false, true],
    });
    const { client, dispose } = setup(state);
    await client.call('browser', 'waitForLoadState', ['t-1', 'networkidle']);
    expect(state.evaluateCallCount).toBeGreaterThanOrEqual(1);
    dispose();
  });
});

describe('realm RPC: browser channel — new ops error paths', () => {
  it('closeTab still throws unknown op for garbage op names', async () => {
    const { client, dispose } = setup(makeBrowserState());
    await expect(client.call('browser', 'totallyUnknownOp', [])).rejects.toThrow(
      /unknown browser op/
    );
    dispose();
  });
});
