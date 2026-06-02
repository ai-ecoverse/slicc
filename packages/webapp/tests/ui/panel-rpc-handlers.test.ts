import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaderTrayRuntimeStatus } from '../../src/scoops/tray-leader.js';
import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';

/**
 * Targeted tests for the `tray-reset` panel-RPC handler. The factory
 * returns a record of handlers — most of them touch DOM APIs and are
 * covered elsewhere; this suite is concerned only with the tray-reset
 * branch, which has no DOM dependency.
 */

function leaderStatus(): LeaderTrayRuntimeStatus {
  return {
    state: 'leader',
    session: {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-new',
      createdAt: '2026-05-17T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/controller-1',
      joinUrl: 'https://tray.example.com/join/tray-new',
      webhookUrl: 'https://tray.example.com/webhooks/tray-new',
      leaderKey: 'leader-key',
      leaderWebSocketUrl: 'wss://tray.example.com/ws',
      runtime: 'slicc-standalone',
    },
    error: null,
  };
}

describe('createStandalonePanelRpcHandlers — tray-reset', () => {
  it('calls the resetTray callback and returns its result', async () => {
    let invocations = 0;
    const expected = leaderStatus();
    const handlers = createStandalonePanelRpcHandlers({
      resetTray: async () => {
        invocations += 1;
        return expected;
      },
    });
    const trayReset = handlers['tray-reset'];
    expect(trayReset).toBeTypeOf('function');
    const result = await trayReset!(undefined);
    expect(invocations).toBe(1);
    expect(result).toEqual(expected);
  });

  it('rejects with a clear error when no resetTray callback is wired', async () => {
    // Mirrors the standalone state where the page has not started a
    // leader tray (or the variable is still null). The handler should
    // surface this as an error string the worker can render.
    const handlers = createStandalonePanelRpcHandlers({});
    await expect(handlers['tray-reset']!(undefined)).rejects.toThrow(/no active tray session/i);
  });

  it('propagates a failure from the resetTray callback', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      resetTray: async () => {
        throw new Error('tray worker unreachable');
      },
    });
    await expect(handlers['tray-reset']!(undefined)).rejects.toThrow(/tray worker unreachable/);
  });
});

describe('createStandalonePanelRpcHandlers — tray-leave', () => {
  it('forwards the payload to the leaveTray callback and returns its result', async () => {
    const calls: Array<{ workerBaseUrl: string | null; requestId?: string }> = [];
    const handlers = createStandalonePanelRpcHandlers({
      leaveTray: async (opts) => {
        calls.push(opts);
        return { kind: 'left', previousMode: 'leader' };
      },
    });
    const result = await handlers['tray-leave']!({
      workerBaseUrl: 'https://new.example',
      requestId: 'req-1',
    });
    expect(calls).toEqual([{ workerBaseUrl: 'https://new.example', requestId: 'req-1' }]);
    expect(result).toEqual({ kind: 'left', previousMode: 'leader' });
  });

  it('forwards an undefined requestId without populating the opts shape', async () => {
    let captured: { workerBaseUrl: string | null; requestId?: string } | undefined;
    const handlers = createStandalonePanelRpcHandlers({
      leaveTray: async (opts) => {
        captured = opts;
        return { kind: 'noop' };
      },
    });
    await handlers['tray-leave']!({ workerBaseUrl: null });
    expect(captured).toEqual({ workerBaseUrl: null, requestId: undefined });
  });

  it('rejects with a clear error when no leaveTray callback is wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      // No leaveTray — mimics the boot moment before main.ts wires it.
    });
    await expect(handlers['tray-leave']!({ workerBaseUrl: null })).rejects.toThrow(
      /not available in this environment/i
    );
  });

  it('propagates a failure from the leaveTray callback (half-state on startLeader)', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      leaveTray: async () => {
        throw new Error('worker unreachable');
      },
    });
    await expect(handlers['tray-leave']!({ workerBaseUrl: 'https://x' })).rejects.toThrow(
      /worker unreachable/
    );
  });
});

/**
 * `oauth-extras-set` is the panel-RPC op that lets a worker-side
 * `oauth-domain` write reach real page `localStorage`. The handler
 * delegates to `setExtraOAuthDomains` (which writes through
 * `sharedWriteOAuthExtras`) and echoes the post-write store back so
 * the worker can mirror it into its shim before resolving — the
 * page→worker storage forward runs on a different channel and offers
 * no ordering guarantee against the panel-rpc response.
 */
describe('createStandalonePanelRpcHandlers — oauth-extras-set', () => {
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    lsData = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      get length(): number {
        return Object.keys(lsData).length;
      },
      key: (i: number) => Object.keys(lsData)[i] ?? null,
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
    };
  });

  afterEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
  });

  it('writes the extras through to localStorage and returns the merged store', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const handler = handlers['oauth-extras-set'];
    expect(handler).toBeTypeOf('function');
    const result = await handler!({
      providerId: 'adobe',
      domains: ['admin.hlx.page', '*.aem.page'],
    });
    expect(result).toEqual({ storeAfter: { adobe: ['admin.hlx.page', '*.aem.page'] } });
    // Real-localStorage write fired through to the underlying map —
    // this is the assertion that the bug at issue #701 (writes
    // never leaving the worker's shim) is fixed.
    expect(lsData.slicc_oauth_extra_domains).toBe(
      JSON.stringify({ adobe: ['admin.hlx.page', '*.aem.page'] })
    );
  });

  it('preserves other providers and overwrites the targeted one', async () => {
    lsData.slicc_oauth_extra_domains = JSON.stringify({
      adobe: ['old.example.com'],
      github: ['hub.example.com'],
    });
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['oauth-extras-set']!({
      providerId: 'adobe',
      domains: ['new.example.com'],
    });
    expect(result.storeAfter).toEqual({
      adobe: ['new.example.com'],
      github: ['hub.example.com'],
    });
  });

  it('empty domains array drops the provider entry', async () => {
    lsData.slicc_oauth_extra_domains = JSON.stringify({
      adobe: ['admin.hlx.page'],
      github: ['hub.example.com'],
    });
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['oauth-extras-set']!({
      providerId: 'adobe',
      domains: [],
    });
    expect(result.storeAfter).toEqual({ github: ['hub.example.com'] });
  });
});

/**
 * `save-oauth-accounts` mirrors `oauth-extras-set` for the canonical
 * `slicc_accounts` array. Worker-side `saveOAuthAccount` calls (from
 * `mcp add` / MCP `onSilentRenew`) would otherwise land only in the
 * kernel-worker shim and be lost on reload — issue #701. The handler
 * writes the serialized JSON through to real page `localStorage` and
 * echoes the stored value back so the worker can mirror it into its
 * shim atomically.
 */
describe('createStandalonePanelRpcHandlers — save-oauth-accounts', () => {
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    lsData = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      get length(): number {
        return Object.keys(lsData).length;
      },
      key: (i: number) => Object.keys(lsData)[i] ?? null,
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
    };
  });

  afterEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
  });

  it('writes the serialized accounts JSON to localStorage and returns the stored value', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const handler = handlers['save-oauth-accounts'];
    expect(handler).toBeTypeOf('function');
    const accounts = [
      {
        providerId: 'mcp:secrets',
        apiKey: '',
        accessToken: 'tok-1',
        refreshToken: 'rt-1',
        tokenExpiresAt: 9_999_999_999_999,
      },
    ];
    const accountsJson = JSON.stringify(accounts);
    const result = await handler!({ accountsJson });
    expect(result).toEqual({ storedJson: accountsJson });
    // The real-localStorage write is what makes MCP OAuth survive a
    // reload — without it the worker's shim Map would swallow the
    // write (issue #701).
    expect(lsData.slicc_accounts).toBe(accountsJson);
  });

  it('overwrites any previously stored accounts array', async () => {
    lsData.slicc_accounts = JSON.stringify([{ providerId: 'github', apiKey: 'gh' }]);
    const handlers = createStandalonePanelRpcHandlers({});
    const next = JSON.stringify([
      { providerId: 'github', apiKey: 'gh' },
      { providerId: 'mcp:foo', apiKey: '', accessToken: 'tok' },
    ]);
    const result = await handlers['save-oauth-accounts']!({ accountsJson: next });
    expect(result.storedJson).toBe(next);
    expect(lsData.slicc_accounts).toBe(next);
  });
});

describe('createStandalonePanelRpcHandlers — list-tray-followers', () => {
  it('returns empty followers and null bestRuntimeId when no listTrayFollowers callback wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['list-tray-followers']!(undefined);
    expect(result).toEqual({ followers: [], bestRuntimeId: null });
  });

  it('returns the result of the listTrayFollowers callback', async () => {
    const followers = [
      { runtimeId: 'f-1', runtime: 'slicc-standalone', floatType: 'standalone' as const },
    ];
    const handlers = createStandalonePanelRpcHandlers({
      listTrayFollowers: () => ({ followers, bestRuntimeId: 'f-1' }),
    });
    const result = await handlers['list-tray-followers']!(undefined);
    expect(result).toEqual({ followers, bestRuntimeId: 'f-1' });
  });
});

describe('createStandalonePanelRpcHandlers — list-remote-targets', () => {
  it('returns empty targets when no listRemoteTargets callback wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['list-remote-targets']!(undefined);
    expect(result).toEqual({ targets: [] });
  });

  it('filters to composite targetIds only', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      listRemoteTargets: () => [
        { targetId: 'local-1', title: 'Local Tab', url: 'https://local.example.com' },
        {
          targetId: 'runtime-abc:tab-1',
          title: 'Follower Tab',
          url: 'https://follower.example.com',
        },
      ],
    });
    const result = await handlers['list-remote-targets']!(undefined);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].targetId).toBe('runtime-abc:tab-1');
  });
});
