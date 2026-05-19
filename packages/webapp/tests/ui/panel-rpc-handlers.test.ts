import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';
import type { LeaderTrayRuntimeStatus } from '../../src/scoops/tray-leader.js';

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
